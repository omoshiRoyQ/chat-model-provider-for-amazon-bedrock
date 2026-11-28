import type * as vscode from 'vscode';
import { parseOffer, priceUrl, type PriceTable } from './pricing';
import { fetchHttpsText } from './proxy';
import { priceMigrationMarkerKey, type SharedPriceBacking } from './sharedStorage';

/** Covers the whole download including the body, which is larger than a model card; a hung request would leave the progress notification open. */
const TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Price tables exist only after the user selects Update Prices; there is no bundled fallback, so estimates never use stale prices silently.
 * Tables are stored per region in Default Profile's shared storage so every VS Code Profile sees the same download.
 * `memento` is read only to migrate tables saved by older versions; nothing new is written to it except the migration marker.
 */
export class PriceStore {
    constructor(
        private readonly memento: vscode.Memento,
        private readonly sharedBacking?: SharedPriceBacking,
    ) { }

    private legacyKey(region: string): string {
        return `prices:${region}`;
    }

    /** Returns the shared table; until the one-time migration has run, a table saved by an older version is shown instead. */
    get(region: string): PriceTable | undefined {
        if (!this.sharedBacking) {
            return undefined;
        }
        const shared = this.sharedBacking.readRegion(region);
        if (shared) {
            return shared;
        }
        if (this.memento.get<boolean>(priceMigrationMarkerKey(region))) {
            return undefined;
        }
        return this.memento.get<PriceTable>(this.legacyKey(region));
    }

    /** Copies an older per-Profile table into shared storage once, without replacing a table another Profile already saved. */
    async migrateLegacy(region: string): Promise<void> {
        if (!priceUrl(region) || !this.sharedBacking || this.memento.get<boolean>(priceMigrationMarkerKey(region))) {
            return;
        }
        const legacy = this.memento.get<PriceTable>(this.legacyKey(region));
        if (legacy) {
            await this.sharedBacking.writeRegion(region, (current) => current ?? legacy);
        }
        await this.memento.update(priceMigrationMarkerKey(region), true);
    }

    /**
     * Downloads the public price file for a region. Sends only an HTTPS GET to a fixed AWS URL, with no account information.
     * Throws on failure for the caller to display; overwrites the saved table only after a successful download.
     * Throws before any request when shared storage is unavailable; nothing is saved to the Profile's own storage instead.
     */
    async download(region: string, proxyUrl?: string): Promise<PriceTable> {
        const url = priceUrl(region);
        if (!url) {
            throw new Error(`Invalid AWS region format: ${region}`);
        }
        const backing = this.sharedBacking;
        if (!backing) {
            throw new Error('Shared price storage is unavailable; prices were not downloaded.');
        }
        const text = await fetchHttpsText(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_DOWNLOAD_BYTES, proxyUrl });
        const table = parseOffer(JSON.parse(text), region, url);
        if (Object.keys(table.models).length === 0) {
            throw new Error(`No model token prices were found in the price file (${url})`);
        }
        await backing.writeRegion(region, () => table);
        return table;
    }
}
