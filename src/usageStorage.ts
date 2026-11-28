import type * as vscode from 'vscode';
import { LockedJsonFile, resolveDefaultProfileStorageDir, type StorageLog, type StorageUri } from './sharedStorage';
import type { UsagePeriod } from './usage';

export { resolveDefaultProfileStorageDir };

const SHARED_USAGE_FILE = 'shared-usage.json';
const MIGRATED_KEY_PREFIX = 'usageMigratedToShared:';
/** Maximum safe signed 32-bit timeout accepted by Node.js `setTimeout` (~24.85 days). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

interface SharedUsageDocument {
    readonly version: 1;
    readonly profiles: Record<string, UsagePeriod>;
}

function parseSharedUsageDocument(raw: unknown): SharedUsageDocument {
    const parsed = raw as Partial<SharedUsageDocument> | null;
    if (parsed?.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
        throw new Error('Invalid shared usage document.');
    }
    return { version: 1, profiles: Object.assign(Object.create(null), parsed.profiles) };
}

export interface SharedUsageBacking {
    readProfile(profile: string): UsagePeriod | undefined;
    writeProfile(profile: string, mutate: (current: UsagePeriod | undefined) => UsagePeriod): Promise<UsagePeriod>;
    dispose(): void;
}

/** Uses the same locked local backing for `file` and locally mapped `vscode-userdata` URIs. */
export function createSharedUsageBacking(
    globalStorageUri: StorageUri | undefined,
    onExternalChange: () => void,
    log: StorageLog,
): SharedUsageBacking | undefined {
    const dir = resolveDefaultProfileStorageDir(globalStorageUri, log);
    return dir ? new FileSharedUsageBacking(dir, onExternalChange, log) : undefined;
}

/**
 * File-backed shared storage under Default Profile's `globalStorage/<extId>/shared-usage.json`.
 * Holds an exclusive lock across the read, mutation, and atomic replacement of the entire document.
 */
export class FileSharedUsageBacking implements SharedUsageBacking {
    private readonly file: LockedJsonFile<SharedUsageDocument>;

    constructor(
        storageDir: string,
        onExternalChange?: () => void,
        log?: Pick<vscode.LogOutputChannel, 'warn'>,
    ) {
        this.file = new LockedJsonFile<SharedUsageDocument>({
            storageDir,
            fileName: SHARED_USAGE_FILE,
            label: 'shared usage',
            createEmpty: () => ({ version: 1, profiles: Object.create(null) }),
            parse: parseSharedUsageDocument,
            onExternalChange,
            log,
        });
    }

    get path(): string {
        return this.file.path;
    }

    readProfile(profile: string): UsagePeriod | undefined {
        return this.file.read()?.profiles[profile];
    }

    writeProfile(profile: string, mutate: (current: UsagePeriod | undefined) => UsagePeriod): Promise<UsagePeriod> {
        return this.file.write((doc) => {
            const nextPeriod = mutate(doc.profiles[profile]);
            doc.profiles[profile] = nextPeriod;
            return { doc, result: nextPeriod };
        });
    }

    dispose(): void {
        this.file.dispose();
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
