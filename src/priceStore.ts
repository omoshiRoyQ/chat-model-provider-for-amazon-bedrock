import type * as vscode from 'vscode';
import { parseOffer, priceUrl, type PriceTable } from './pricing';

/** Covers the whole download including the body, which is larger than a model card; a hung request would leave the progress notification open. */
const TIMEOUT_MS = 60_000;

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
    async download(region: string): Promise<PriceTable> {
        const url = priceUrl(region);
        if (!url) {
            throw new Error(`Invalid AWS region format: ${region}`);
        }
        const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText} (${url})`);
        }
        const table = parseOffer(await response.json(), region, url);
        if (Object.keys(table.models).length === 0) {
            throw new Error(`No model token prices were found in the price file (${url})`);
        }
        await this.memento.update(this.key(region), table);
        return table;
    }
}
