import type * as vscode from 'vscode';
import { parseOffer, priceUrl, type PriceTable } from './pricing';
import { fetchHttpsText } from './proxy';

/** Covers the whole download including the body, which is larger than a model card; a hung request would leave the progress notification open. */
const TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** Price tables exist only after the user selects Update Prices; there is no bundled fallback, so estimates never use stale prices silently. */
export class PriceStore {
    constructor(private readonly memento: vscode.Memento) { }

    private key(region: string): string {
        return `prices:${region}`;
    }

    get(region: string): PriceTable | undefined {
        return this.memento.get<PriceTable>(this.key(region));
    }

    /**
    * Downloads the public price file for a region. Sends only an HTTPS GET to a fixed AWS URL, with no account information.
    * Throws on failure for the caller to display; overwrites the saved table only after a successful download.
     */
    async download(region: string, proxyUrl?: string): Promise<PriceTable> {
        const url = priceUrl(region);
        if (!url) {
            throw new Error(`Invalid AWS region format: ${region}`);
        }
        const text = await fetchHttpsText(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_DOWNLOAD_BYTES, proxyUrl });
        const table = parseOffer(JSON.parse(text), region, url);
        if (Object.keys(table.models).length === 0) {
            throw new Error(`No model token prices were found in the price file (${url})`);
        }
        await this.memento.update(this.key(region), table);
        return table;
    }
}
