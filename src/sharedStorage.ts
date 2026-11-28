import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type * as vscode from 'vscode';
import type { ModelCard } from './modelCards';
import type { PriceTable } from './pricing';

export const SHARED_PRICES_FILE = 'shared-prices.json';
export const SHARED_MODEL_CARDS_FILE = 'shared-model-cards.json';
export const MODEL_CARD_MIGRATION_MARKER_KEY = 'modelCardMigratedToShared';

const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const PRICE_MIGRATED_KEY_PREFIX = 'priceMigratedToShared:';

export type StorageUri = Pick<vscode.Uri, 'scheme' | 'fsPath'> & Partial<Pick<vscode.Uri, 'authority'>>;
export type StorageLog = Pick<vscode.LogOutputChannel, 'info' | 'warn'>;

const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

function capitalize(label: string): string {
    return label.length > 0 ? label[0].toUpperCase() + label.slice(1) : label;
}

/**
 * Resolves the Default Profile's `globalStorage/<extId>` directory from `ExtensionContext.globalStorageUri`.
 *
 * - Default Profile: `<User>/globalStorage/<extId>` -> kept as-is.
 * - Named VS Code Profile: `<User>/profiles/<profileId>/globalStorage/<extId>` -> mapped to `<User>/globalStorage/<extId>`.
 * - Local `vscode-userdata` URIs use the same mapping; unsupported URIs return `undefined`.
 */
export function resolveDefaultProfileStorageDir(
    globalStorageUri: StorageUri | undefined,
    log?: StorageLog,
    unavailableWarning = 'Shared usage storage is unavailable; local usage will not be recorded.',
): string | undefined {
    const fsPath = globalStorageUri?.fsPath;
    const scheme = globalStorageUri?.scheme;
    if (!fsPath || globalStorageUri?.authority || !isAbsolute(fsPath) ||
        (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(fsPath)) ||
        (scheme !== 'file' && (scheme !== 'vscode-userdata' || basename(dirname(fsPath)).toLowerCase() !== 'globalstorage'))) {
        log?.warn(unavailableWarning);
        return undefined;
    }
    const resolved = resolve(fsPath);
    const extSegment = basename(resolved);
    const globalStorageDir = dirname(resolved);
    if (basename(globalStorageDir).toLowerCase() !== 'globalstorage' || !extSegment) {
        log?.info('Unexpected globalStorageUri layout; keeping current directory for shared storage.');
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

export interface LockedJsonFileOptions<TDoc> {
    readonly storageDir: string;
    readonly fileName: string;
    readonly label: string;
    readonly createEmpty: () => TDoc;
    readonly parse: (raw: unknown) => TDoc;
    readonly onExternalChange?: () => void;
    readonly log?: Pick<vscode.LogOutputChannel, 'warn'>;
}

/**
 * Coordinates cross-process access to a single shared JSON file under Default Profile's `globalStorage/<extId>/`.
 * Uses a dedicated Node built-in SQLite sidecar lock (`<file>.lock.sqlite`), `0o600` temp-file atomic rename,
 * and a debounced directory watcher filtered to the target filename.
 */
export class LockedJsonFile<TDoc> implements vscode.Disposable {
    private readonly dirPath: string;
    private readonly filePath: string;
    private readonly fileName: string;
    private readonly label: string;
    private readonly createEmpty: () => TDoc;
    private readonly parse: (raw: unknown) => TDoc;
    private readonly onExternalChange?: () => void;
    private readonly log?: Pick<vscode.LogOutputChannel, 'warn'>;
    private watcher: FSWatcher | undefined;
    private debounceTimer: NodeJS.Timeout | undefined;
    private suppressWatchUntil = 0;

    constructor(options: LockedJsonFileOptions<TDoc>) {
        this.dirPath = resolve(options.storageDir);
        this.fileName = options.fileName;
        this.filePath = join(this.dirPath, options.fileName);
        this.label = options.label;
        this.createEmpty = options.createEmpty;
        this.parse = options.parse;
        this.onExternalChange = options.onExternalChange;
        this.log = options.log;
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
                if (filename && filename !== this.fileName) {
                    return;
                }
                if (Date.now() < this.suppressWatchUntil) {
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
                this.log?.warn(`${capitalize(this.label)} file watcher error: ${err.message}`);
            });
        } catch (error) {
            this.log?.warn(`Could not watch ${this.label} directory: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private readStrict(): TDoc {
        let text: string;
        try {
            text = readFileSync(this.filePath, 'utf8');
        } catch (error) {
            if (isNotFound(error)) return this.createEmpty();
            throw error;
        }
        return this.parse(JSON.parse(text));
    }

    read(): TDoc | undefined {
        try {
            return this.readStrict();
        } catch {
            this.log?.warn(`Could not read the ${this.label} file. Existing data was not changed.`);
            return undefined;
        }
    }

    async write<TResult>(mutate: (doc: TDoc) => { doc: TDoc; result: TResult }): Promise<TResult> {
        mkdirSync(this.dirPath, { recursive: true });
        const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;
        if (!sqlite) throw new Error(`${capitalize(this.label)} locking is unavailable.`);
        const db = new sqlite.DatabaseSync(`${this.filePath}.lock.sqlite`);
        try {
            await this.acquireLock(db);
            const tempPath = join(this.dirPath, `.${this.fileName}.${process.pid}.${randomUUID()}.tmp`);
            try {
                const current = this.readStrict();
                const { doc: nextDoc, result } = mutate(current);
                writeFileSync(tempPath, JSON.stringify(nextDoc), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                this.suppressWatchUntil = Date.now() + 150;
                renameSync(tempPath, this.filePath);
                return result;
            } finally {
                try {
                    unlinkSync(tempPath);
                } catch (error) {
                    if (!isNotFound(error)) this.log?.warn(`Could not remove a temporary ${this.label} file.`);
                }
            }
        } finally {
            try {
                db.close();
            } catch {
                this.log?.warn(`Could not close the ${this.label} lock.`);
            }
        }
    }

    private async acquireLock(db: DatabaseSync): Promise<void> {
        const SQLITE_BUSY = 5;
        const started = performance.now();
        for (;;) {
            try {
                // The sidecar holds no application data. Closing the connection or exiting releases the transaction lock.
                db.exec('BEGIN IMMEDIATE');
                return;
            } catch (error) {
                if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
                if (performance.now() - started >= LOCK_WAIT_MS) throw new Error(`Timed out waiting for the ${this.label} lock.`);
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

export interface SharedPricesDocument {
    readonly version: 1;
    readonly regions: Record<string, PriceTable>;
}

export interface SharedPriceBacking extends vscode.Disposable {
    readRegion(region: string): PriceTable | undefined;
    writeRegion(region: string, mutate: (current: PriceTable | undefined) => PriceTable): Promise<PriceTable>;
}

function parseSharedPricesDocument(raw: unknown): SharedPricesDocument {
    const parsed = raw as Partial<SharedPricesDocument> | null;
    if (parsed?.version !== 1 || !parsed.regions || typeof parsed.regions !== 'object' || Array.isArray(parsed.regions)) {
        throw new Error('Invalid shared price document.');
    }
    return { version: 1, regions: Object.assign(Object.create(null), parsed.regions) };
}

export function priceMigrationMarkerKey(region: string): string {
    return `${PRICE_MIGRATED_KEY_PREFIX}${region}`;
}

/**
 * File-backed shared regional price storage under Default Profile's `globalStorage/<extId>/shared-prices.json`.
 */
export class FileSharedPriceBacking implements SharedPriceBacking {
    private readonly file: LockedJsonFile<SharedPricesDocument>;

    constructor(
        storageDir: string,
        onExternalChange?: () => void,
        log?: Pick<vscode.LogOutputChannel, 'warn'>,
    ) {
        this.file = new LockedJsonFile<SharedPricesDocument>({
            storageDir,
            fileName: SHARED_PRICES_FILE,
            label: 'shared price',
            createEmpty: () => ({ version: 1, regions: Object.create(null) }),
            parse: parseSharedPricesDocument,
            onExternalChange,
            log,
        });
    }

    get path(): string {
        return this.file.path;
    }

    readRegion(region: string): PriceTable | undefined {
        return this.file.read()?.regions[region];
    }

    writeRegion(region: string, mutate: (current: PriceTable | undefined) => PriceTable): Promise<PriceTable> {
        return this.file.write((doc) => {
            const nextTable = mutate(doc.regions[region]);
            doc.regions[region] = nextTable;
            return { doc, result: nextTable };
        });
    }

    dispose(): void {
        this.file.dispose();
    }
}

export function createSharedPriceBacking(
    globalStorageUri: StorageUri | undefined,
    onExternalChange: () => void,
    log?: StorageLog,
): SharedPriceBacking | undefined {
    const dir = resolveDefaultProfileStorageDir(
        globalStorageUri,
        log,
        'Shared price storage is unavailable; downloaded prices will not be saved.',
    );
    return dir ? new FileSharedPriceBacking(dir, onExternalChange, log) : undefined;
}

export interface CachedModelCards {
    /** Cards parsed by an older version lack newer fields (such as pricing) and are fetched again. */
    readonly version?: number;
    readonly checkedAt: number;
    /** Model IDs that were missing from the catalog when the cards were last fetched. */
    readonly searched: readonly string[];
    readonly cards: Readonly<Record<string, ModelCard>>;
}

export interface SharedModelCardsDocument {
    readonly version: 1;
    readonly cache?: CachedModelCards;
}

export interface SharedModelCardBacking extends vscode.Disposable {
    readCache(): CachedModelCards | undefined;
    writeCache(mutate: (current: CachedModelCards | undefined) => CachedModelCards): Promise<CachedModelCards>;
}

function parseSharedModelCardsDocument(raw: unknown): SharedModelCardsDocument {
    const parsed = raw as Partial<SharedModelCardsDocument> | null;
    if (parsed?.version !== 1 || (parsed.cache !== undefined && (typeof parsed.cache !== 'object' || parsed.cache === null || Array.isArray(parsed.cache)))) {
        throw new Error('Invalid shared model card document.');
    }
    return parsed.cache ? { version: 1, cache: parsed.cache } : { version: 1 };
}

/**
 * File-backed shared model-card cache under Default Profile's `globalStorage/<extId>/shared-model-cards.json`.
 */
export class FileSharedModelCardBacking implements SharedModelCardBacking {
    private readonly file: LockedJsonFile<SharedModelCardsDocument>;

    constructor(
        storageDir: string,
        onExternalChange?: () => void,
        log?: Pick<vscode.LogOutputChannel, 'warn'>,
    ) {
        this.file = new LockedJsonFile<SharedModelCardsDocument>({
            storageDir,
            fileName: SHARED_MODEL_CARDS_FILE,
            label: 'shared model card',
            createEmpty: () => ({ version: 1 }),
            parse: parseSharedModelCardsDocument,
            onExternalChange,
            log,
        });
    }

    get path(): string {
        return this.file.path;
    }

    readCache(): CachedModelCards | undefined {
        return this.file.read()?.cache;
    }

    writeCache(mutate: (current: CachedModelCards | undefined) => CachedModelCards): Promise<CachedModelCards> {
        return this.file.write((doc) => {
            const nextCache = mutate(doc.cache);
            return { doc: { version: 1, cache: nextCache }, result: nextCache };
        });
    }

    dispose(): void {
        this.file.dispose();
    }
}

export function createSharedModelCardBacking(
    globalStorageUri: StorageUri | undefined,
    onExternalChange: () => void,
    log?: StorageLog,
): SharedModelCardBacking | undefined {
    const dir = resolveDefaultProfileStorageDir(
        globalStorageUri,
        log,
        'Shared model card storage is unavailable; downloaded model cards will not be saved.',
    );
    return dir ? new FileSharedModelCardBacking(dir, onExternalChange, log) : undefined;
}
