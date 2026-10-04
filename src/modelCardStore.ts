import type * as vscode from 'vscode';
import { MODEL_CARD_INDEX_URL, modelCardNames, modelCardUrl, parseModelCard, type ModelCard } from './modelCards';

interface CachedCards {
    /** Cards parsed by an older version lack newer fields (such as pricing) and are fetched again. */
    readonly version?: number;
    readonly checkedAt: number;
    /** Model IDs that were missing from the catalog when the cards were last fetched. */
    readonly searched: readonly string[];
    readonly cards: Readonly<Record<string, ModelCard>>;
}

const KEY = 'modelCardCache';
const VERSION = 2;
/** Cached pages are fetched again after this age so later corrections in AWS documentation are picked up. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;
const TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} (${url})`);
    }
    return response.text();
}

/**
 * Caches token limits and prices from public AWS model-card pages.
 * Sends only HTTPS GET requests to fixed AWS documentation URLs, with no account information.
 */
export class ModelCardStore {
    private inFlight: Promise<{ fetched: number; failed: string[] }> | undefined;

    constructor(private readonly memento: vscode.Memento) { }

    private cached(): CachedCards {
        const cached = this.memento.get<CachedCards>(KEY);
        return cached?.version === VERSION ? cached : { version: VERSION, checkedAt: 0, searched: [], cards: {} };
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
     * Throws if the index cannot be read. Pages that fail are skipped and the searched list is cleared, so the next model-list load tries again.
     */
    refresh(unknownIds: readonly string[], now = Date.now(), force = false): Promise<{ fetched: number; failed: string[] }> {
        this.inFlight ??= this.download(unknownIds, now, force).finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }

    private async download(unknownIds: readonly string[], now: number, force: boolean): Promise<{ fetched: number; failed: string[] }> {
        const previous = this.cached();
        const reusable = !force && now - previous.checkedAt < MAX_AGE_MS ? previous.cards : {};
        const names = modelCardNames(await fetchText(MODEL_CARD_INDEX_URL));
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
                    cards[name] = parseModelCard(name, await fetchText(modelCardUrl(name)));
                } catch {
                    failed.push(name);
                    // Keep the last good copy so one failed page does not drop a model's price; cards removed from the index are not kept.
                    if (previous.cards[name]) {
                        cards[name] = previous.cards[name];
                    }
                }
            }
        }));
        await this.memento.update(KEY, {
            version: VERSION,
            checkedAt: now,
            searched: failed.length > 0 ? [] : [...new Set([...previous.searched, ...unknownIds])],
            cards,
        } satisfies CachedCards);
        return { fetched: pending.length - failed.length, failed };
    }
}
