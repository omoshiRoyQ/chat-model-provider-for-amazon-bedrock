import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type * as vscode from 'vscode';
import type { UsagePeriod } from './usage';

const SHARED_USAGE_FILE = 'shared-usage.json';
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const MIGRATED_KEY_PREFIX = 'usageMigratedToShared:';
/** Maximum safe signed 32-bit timeout accepted by Node.js `setTimeout` (~24.85 days). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

interface SharedUsageDocument {
    readonly version: 1;
    readonly profiles: Record<string, UsagePeriod>;
}

type StorageUri = Pick<vscode.Uri, 'scheme' | 'fsPath'> & Partial<Pick<vscode.Uri, 'authority'>>;

/**
 * Resolves the Default Profile's `globalStorage/<extId>` directory from `ExtensionContext.globalStorageUri`.
 *
 * - Default Profile: `<User>/globalStorage/<extId>` -> kept as-is.
 * - Named VS Code Profile: `<User>/profiles/<profileId>/globalStorage/<extId>` -> mapped to `<User>/globalStorage/<extId>`.
 * - Local `vscode-userdata` URIs use the same mapping; unsupported URIs return `undefined`.
 */
export function resolveDefaultProfileStorageDir(
    globalStorageUri: StorageUri | undefined,
    log?: Pick<vscode.LogOutputChannel, 'info' | 'warn'>,
): string | undefined {
    const fsPath = globalStorageUri?.fsPath;
    const scheme = globalStorageUri?.scheme;
    if (!fsPath || globalStorageUri?.authority || !isAbsolute(fsPath) ||
        (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(fsPath)) ||
        (scheme !== 'file' && (scheme !== 'vscode-userdata' || basename(dirname(fsPath)).toLowerCase() !== 'globalstorage'))) {
        log?.warn('Shared usage storage is unavailable; local usage will not be recorded.');
        return undefined;
    }
    const resolved = resolve(fsPath);
    const extSegment = basename(resolved);
    const globalStorageDir = dirname(resolved);
    if (basename(globalStorageDir).toLowerCase() !== 'globalstorage' || !extSegment) {
        log?.info('Unexpected globalStorageUri layout; keeping current directory for usage storage.');
        return resolved;
    }
    const parentDir = dirname(globalStorageDir);
    const grandParentDir = dirname(parentDir);
    if (basename(grandParentDir).toLowerCase() === 'profiles') {
        const userDir = dirname(grandParentDir);
        if (userDir && userDir !== grandParentDir) {
            return join(userDir, 'globalStorage', extSegment);
        }
    }
    return resolved;
}

export interface SharedUsageBacking {
    readProfile(profile: string): UsagePeriod | undefined;
    writeProfile(profile: string, mutate: (current: UsagePeriod | undefined) => UsagePeriod): Promise<UsagePeriod>;
    dispose(): void;
}

const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Uses the same locked local backing for `file` and locally mapped `vscode-userdata` URIs. */
export function createSharedUsageBacking(
    globalStorageUri: StorageUri | undefined,
    onExternalChange: () => void,
    log: Pick<vscode.LogOutputChannel, 'info' | 'warn'>,
): SharedUsageBacking | undefined {
    const dir = resolveDefaultProfileStorageDir(globalStorageUri, log);
    return dir ? new FileSharedUsageBacking(dir, onExternalChange, log) : undefined;
}

/**
 * File-backed shared storage under Default Profile's `globalStorage/<extId>/shared-usage.json`.
 * Holds an exclusive lock across the read, mutation, and atomic replacement of the entire document.
 */
export class FileSharedUsageBacking implements SharedUsageBacking {
    private readonly filePath: string;
    private readonly dirPath: string;
    private watcher: FSWatcher | undefined;
    private debounceTimer: NodeJS.Timeout | undefined;

    constructor(
        storageDir: string,
        private readonly onExternalChange?: () => void,
        private readonly log?: Pick<vscode.LogOutputChannel, 'warn'>,
    ) {
        this.dirPath = resolve(storageDir);
        this.filePath = join(this.dirPath, SHARED_USAGE_FILE);
        this.startWatching();
    }

    get path(): string {
        return this.filePath;
    }

    private startWatching(): void {
        if (!this.onExternalChange) {
            return;
        }
        try {
            mkdirSync(this.dirPath, { recursive: true });
            this.watcher = watch(this.dirPath, (_eventType, filename) => {
                if (filename && filename !== SHARED_USAGE_FILE) {
                    return;
                }
                if (this.debounceTimer) {
                    clearTimeout(this.debounceTimer);
                }
                this.debounceTimer = setTimeout(() => {
                    this.debounceTimer = undefined;
                    this.onExternalChange?.();
                }, 60);
            });
            this.watcher.on('error', (err) => {
                this.log?.warn(`Shared usage file watcher error: ${err.message}`);
            });
        } catch (error) {
            this.log?.warn(`Could not watch shared usage directory: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private readDocument(): SharedUsageDocument {
        let text: string;
        try {
            text = readFileSync(this.filePath, 'utf8');
        } catch (error) {
            if (isNotFound(error)) return { version: 1, profiles: Object.create(null) };
            throw error;
        }
        const parsed = JSON.parse(text) as Partial<SharedUsageDocument> | null;
        if (parsed?.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
            throw new Error('Invalid shared usage document.');
        }
        return { version: 1, profiles: Object.assign(Object.create(null), parsed.profiles) };
    }

    readProfile(profile: string): UsagePeriod | undefined {
        try {
            return this.readDocument().profiles[profile];
        } catch {
            this.log?.warn('Could not read the shared usage file. Existing data was not changed.');
            return undefined;
        }
    }

    async writeProfile(profile: string, mutate: (current: UsagePeriod | undefined) => UsagePeriod): Promise<UsagePeriod> {
        mkdirSync(this.dirPath, { recursive: true });
        const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;
        if (!sqlite) throw new Error('Shared usage locking is unavailable.');
        const db = new sqlite.DatabaseSync(`${this.filePath}.lock.sqlite`);
        try {
            await this.acquireLock(db);
            const tempPath = join(this.dirPath, `.${SHARED_USAGE_FILE}.${process.pid}.${randomUUID()}.tmp`);
            try {
                const doc = this.readDocument();
                const nextPeriod = mutate(doc.profiles[profile]);
                doc.profiles[profile] = nextPeriod;
                writeFileSync(tempPath, JSON.stringify(doc), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                renameSync(tempPath, this.filePath);
                return nextPeriod;
            } finally {
                try {
                    unlinkSync(tempPath);
                } catch (error) {
                    if (!isNotFound(error)) this.log?.warn('Could not remove a temporary shared usage file.');
                }
            }
        } finally {
            try {
                db.close();
            } catch {
                this.log?.warn('Could not close the shared usage lock.');
            }
        }
    }

    private async acquireLock(db: DatabaseSync): Promise<void> {
        const SQLITE_BUSY = 5;
        const started = performance.now();
        for (;;) {
            try {
                // The sidecar holds no usage data. Closing the connection or exiting releases the transaction lock.
                db.exec('BEGIN IMMEDIATE');
                return;
            } catch (error) {
                if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
                if (performance.now() - started >= LOCK_WAIT_MS) throw new Error('Timed out waiting for the shared usage lock.');
                await delay(LOCK_RETRY_MS);
            }
        }
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        this.watcher?.close();
        this.watcher = undefined;
    }
}

export function migrationMarkerKey(profile: string): string {
    return `${MIGRATED_KEY_PREFIX}${profile}`;
}

/**
 * Schedules a callback to fire when `targetTime` is reached, splitting waits longer than `MAX_TIMEOUT_MS` (~24.85 days)
 * into bounded segments so Node's 32-bit timer never overflows into an immediate 1ms firing.
 */
export class ResetTimer {
    private timer: NodeJS.Timeout | undefined;
    private disposed = false;

    constructor(
        private readonly onDue: () => void,
        private readonly now: () => number = Date.now,
    ) { }

    schedule(target: Date): void {
        this.clear();
        if (this.disposed) {
            return;
        }
        const targetMs = target.getTime();
        if (!Number.isFinite(targetMs)) {
            return;
        }
        const step = () => {
            if (this.disposed) {
                return;
            }
            const remaining = targetMs - this.now();
            if (remaining <= 0) {
                this.timer = undefined;
                this.onDue();
                return;
            }
            const waitMs = Math.min(remaining, MAX_TIMEOUT_MS);
            this.timer = setTimeout(step, waitMs);
        };
        const initialRemaining = Math.max(0, targetMs - this.now());
        this.timer = setTimeout(step, Math.min(initialRemaining, MAX_TIMEOUT_MS));
    }

    clear(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.clear();
    }
}
