import type * as vscode from 'vscode';
import { MODEL_CARD_INDEX_URL, modelCardNames, modelCardUrl, parseModelCard, type ModelCard } from './modelCards';
import { fetchHttpsText } from './proxy';
import { MODEL_CARD_MIGRATION_MARKER_KEY, type CachedModelCards, type SharedModelCardBacking } from './sharedStorage';

/** Key of the cache saved in `globalState` by older versions; read only for the one-time migration. */
const LEGACY_KEY = 'modelCardCache';
const VERSION = 2;
/** Cached pages are fetched again after this age so later corrections in AWS documentation are picked up. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;
const TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Caches token limits and prices from public AWS model-card pages in Default Profile's shared storage,
 * so every VS Code Profile reuses one download.
 * Sends only HTTPS GET requests to fixed AWS documentation URLs, with no account information.
 * `memento` is read only to migrate a cache saved by older versions; nothing new is written to it except the migration marker.
 */
export class ModelCardStore {
    private inFlight: Promise<{ fetched: number; failed: string[] }> | undefined;

    constructor(
        private readonly memento: vscode.Memento,
        private readonly sharedBacking?: SharedModelCardBacking,
    ) { }

    private empty(): CachedModelCards {
        return { version: VERSION, checkedAt: 0, searched: [], cards: {} };
    }

    /** Cards parsed by an older version lack newer fields (such as pricing) and are ignored. */
    private current(cache: CachedModelCards | undefined): CachedModelCards | undefined {
        return cache?.version === VERSION ? cache : undefined;
    }

    private cached(): CachedModelCards {
        if (!this.sharedBacking) {
            return this.empty();
        }
        const shared = this.sharedBacking.readCache();
        if (shared) {
            return this.current(shared) ?? this.empty();
        }
        // Until the one-time migration has run, a cache saved by an older version is still used.
        if (this.memento.get<boolean>(MODEL_CARD_MIGRATION_MARKER_KEY)) {
            return this.empty();
        }
        return this.current(this.memento.get<CachedModelCards>(LEGACY_KEY)) ?? this.empty();
    }

    /** Copies an older per-Profile cache into shared storage once, without replacing a cache another Profile already saved. */
    async migrateLegacy(): Promise<void> {
        if (!this.sharedBacking || this.memento.get<boolean>(MODEL_CARD_MIGRATION_MARKER_KEY)) {
            return;
        }
        const legacy = this.current(this.memento.get<CachedModelCards>(LEGACY_KEY));
        if (legacy) {
            await this.sharedBacking.writeCache((current) => current ?? legacy);
        }
        await this.memento.update(MODEL_CARD_MIGRATION_MARKER_KEY, true);
    }

    /** Cached cards keyed by foundation model ID. */
    limits(): Map<string, ModelCard> {
        const byId = new Map<string, ModelCard>();
        for (const card of Object.values(this.cached().cards)) {
            for (const id of card.runtimeIds) {
                if (!byId.has(id)) {
                    byId.set(id, card);
                }
            }
        }
        return byId;
    }

    /** Fetch again only for newly seen models or when the cache is old, because VS Code reloads the model list often. */
    needsRefresh(unknownIds: readonly string[], now = Date.now()): boolean {
        const cached = this.cached();
        return now - cached.checkedAt >= MAX_AGE_MS || unknownIds.some((id) => !cached.searched.includes(id));
    }

    /**
     * Downloads the page index and every model card not cached yet; `force` downloads every card again (Update Prices).
     * Throws if the index cannot be read or shared storage is unavailable (checked before any request).
     * Pages that fail are skipped and the searched list is cleared, so the next model-list load tries again.
     */
    refresh(unknownIds: readonly string[], now = Date.now(), force = false, proxyUrl?: string): Promise<{ fetched: number; failed: string[] }> {
        this.inFlight ??= this.download(unknownIds, now, force, proxyUrl).finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }

    private async download(unknownIds: readonly string[], now: number, force: boolean, proxyUrl?: string): Promise<{ fetched: number; failed: string[] }> {
        const backing = this.sharedBacking;
        if (!backing) {
            throw new Error('Shared model card storage is unavailable; model cards were not downloaded.');
        }
        const previous = this.cached();
        const reusable = !force && now - previous.checkedAt < MAX_AGE_MS ? previous.cards : {};
        const downloadOptions = { timeoutMs: TIMEOUT_MS, maxBytes: MAX_DOWNLOAD_BYTES, proxyUrl };
        const names = modelCardNames(await fetchHttpsText(MODEL_CARD_INDEX_URL, downloadOptions));
        if (names.length === 0) {
            throw new Error(`No model cards were found in ${MODEL_CARD_INDEX_URL}`);
        }
        const cards: Record<string, ModelCard> = {};
        for (const name of names) {
            if (reusable[name]) {
                cards[name] = reusable[name];
            }
        }
        const pending = names.filter((name) => !cards[name]);
        const failed: string[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
            while (next < pending.length) {
                const name = pending[next++];
                try {
                    cards[name] = parseModelCard(name, await fetchHttpsText(modelCardUrl(name), downloadOptions));
                } catch {
                    failed.push(name);
                    // Keep the last good copy so one failed page does not drop a model's price; cards removed from the index are not kept.
                    if (previous.cards[name]) {
                        cards[name] = previous.cards[name];
                    }
                }
            }
        }));
        await backing.writeCache(() => ({
            version: VERSION,
            checkedAt: now,
            searched: failed.length > 0 ? [] : [...new Set([...previous.searched, ...unknownIds])],
            cards,
        }));
        return { fetched: pending.length - failed.length, failed };
    }
}
