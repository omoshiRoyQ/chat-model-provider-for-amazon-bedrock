import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { PriceStore } from '../src/priceStore';
import type { PriceTable } from '../src/pricing';
import * as proxy from '../src/proxy';
import { FileSharedPriceBacking, priceMigrationMarkerKey } from '../src/sharedStorage';

const makeMemento = (initial: Record<string, unknown> = {}) => {
    const values = new Map<string, unknown>(Object.entries(initial));
    const memento = {
        get: vi.fn(<T>(key: string, defaultValue?: T) => (values.has(key) ? (values.get(key) as T) : defaultValue)),
        update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    };
    return { memento: memento as unknown as vscode.Memento, spy: memento, values };
};

const dirs: string[] = [];
const storageDir = () => {
    mkdirSync('.tmp', { recursive: true });
    const dir = mkdtempSync(resolve('.tmp', 'bedrock-prices-'));
    dirs.push(dir);
    return dir;
};
const backings: FileSharedPriceBacking[] = [];
const backingFor = (dir: string) => {
    const backing = new FileSharedPriceBacking(dir);
    backings.push(backing);
    return backing;
};

afterEach(() => {
    vi.restoreAllMocks();
    for (const backing of backings.splice(0)) backing.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const table = (region: string, publicationDate = '2026-10-04T00:00:00Z'): PriceTable => ({
    region,
    publicationDate,
    source: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${region}/index.json`,
    models: { 'Claude Opus 5.5': { geo: { inputPerM: 5, outputPerM: 25 }, global: { inputPerM: 5, outputPerM: 25 } } },
});

/** Minimal AWS price file: one Claude model with Geo input and output prices (usagetype names from pricing.ts docs, observed 2026-09-25). */
const offer = {
    publicationDate: '2026-11-01T00:00:00Z',
    products: {
        A: { attributes: { servicename: 'Claude Opus 5.5 (Amazon Bedrock Edition)', usagetype: 'USW2-MP:USW2_input_tokens_standard-Units' } },
        B: { attributes: { servicename: 'Claude Opus 5.5 (Amazon Bedrock Edition)', usagetype: 'USW2-MP:USW2_output_tokens_standard-Units' } },
    },
    terms: {
        OnDemand: {
            A: { 'A.1': { priceDimensions: { 'A.1.1': { unit: '1M tokens', pricePerUnit: { USD: '5' } } } } },
            B: { 'B.1': { priceDimensions: { 'B.1.1': { unit: '1M tokens', pricePerUnit: { USD: '25' } } } } },
        },
    },
};

/** Expected behavior comes from the security review (2026-10-09) and proxyUrl decision (2026-11-19): a price download must bound timeout and pass proxyUrl. */
describe('PriceStore.download', () => {
    it('passes a 60-second timeout and proxyUrl to fetchHttpsText', async () => {
        const fetchSpy = vi.spyOn(proxy, 'fetchHttpsText').mockRejectedValue(new Error('HTTP 503 Unavailable'));
        const store = new PriceStore(makeMemento().memento, backingFor(storageDir()));
        await expect(store.download('us-west-2', 'http://proxy.example:8080')).rejects.toThrow('HTTP 503');
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/us-west-2/index.json'),
            { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024, proxyUrl: 'http://proxy.example:8080' },
        );
    });

    it('拒絕不合格式的 region，不發出請求', async () => {
        const fetchSpy = vi.spyOn(proxy, 'fetchHttpsText');
        await expect(new PriceStore(makeMemento().memento).download('../evil')).rejects.toThrow('Invalid AWS region format');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

/** Expected behavior comes from the user's decision (2026-11-28): prices live in Default Profile shared storage like usage, with no fallback to a Profile's own storage. */
describe('PriceStore shared storage', () => {
    it('saves a download to the shared file only, and another Profile on the same directory reads it', async () => {
        vi.spyOn(proxy, 'fetchHttpsText').mockResolvedValue(JSON.stringify(offer));
        const dir = storageDir();
        const profileA = makeMemento();
        const downloaded = await new PriceStore(profileA.memento, backingFor(dir)).download('us-west-2');
        expect(Object.keys(downloaded.models)).toEqual(['Claude Opus 5.5']);
        expect(profileA.spy.update).not.toHaveBeenCalled();

        const fromOther = new PriceStore(makeMemento().memento, backingFor(dir)).get('us-west-2');
        expect(fromOther?.publicationDate).toBe('2026-11-01T00:00:00Z');
        expect(fromOther?.models['Claude Opus 5.5'].geo).toEqual({ inputPerM: 5, outputPerM: 25 });
    });

    it('keeps concurrent downloads of different regions', async () => {
        const dir = storageDir();
        const west = new FileSharedPriceBacking(dir);
        const east = new FileSharedPriceBacking(dir);
        backings.push(west, east);
        await Promise.all([west.writeRegion('us-west-2', () => table('us-west-2')), east.writeRegion('us-east-1', () => table('us-east-1'))]);
        const store = new PriceStore(makeMemento().memento, backingFor(dir));
        expect(store.get('us-west-2')?.region).toBe('us-west-2');
        expect(store.get('us-east-1')?.region).toBe('us-east-1');
    });

    it('rejects before any request without shared storage, and shows no prices', async () => {
        const fetchSpy = vi.spyOn(proxy, 'fetchHttpsText');
        const profile = makeMemento({ 'prices:us-west-2': table('us-west-2') });
        const store = new PriceStore(profile.memento);
        await expect(store.download('us-west-2')).rejects.toThrow('Shared price storage is unavailable');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(profile.spy.update).not.toHaveBeenCalled();
        expect(store.get('us-west-2')).toBeUndefined();
    });

    it('does not replace the saved table when the download or parsing fails', async () => {
        const dir = storageDir();
        const backing = backingFor(dir);
        await backing.writeRegion('us-west-2', () => table('us-west-2', '2026-10-04T00:00:00Z'));
        const store = new PriceStore(makeMemento().memento, backing);

        vi.spyOn(proxy, 'fetchHttpsText').mockRejectedValue(new Error('HTTP 503 Unavailable'));
        await expect(store.download('us-west-2')).rejects.toThrow('HTTP 503');
        vi.spyOn(proxy, 'fetchHttpsText').mockResolvedValue(JSON.stringify({ publicationDate: 'x', products: {}, terms: {} }));
        await expect(store.download('us-west-2')).rejects.toThrow('No model token prices');
        expect(store.get('us-west-2')?.publicationDate).toBe('2026-10-04T00:00:00Z');
    });
});

/** Expected behavior comes from the user's decision (2026-11-28): a table saved by an older version migrates once and never overwrites a table another Profile already saved. */
describe('PriceStore legacy migration', () => {
    const legacy = table('us-west-2', '2026-09-30T00:00:00Z');

    it('shows the old table before migration, then moves it to shared storage and marks it migrated', async () => {
        const dir = storageDir();
        const profile = makeMemento({ 'prices:us-west-2': legacy });
        const store = new PriceStore(profile.memento, backingFor(dir));
        expect(store.get('us-west-2')).toEqual(legacy);

        await store.migrateLegacy('us-west-2');
        expect(profile.values.get(priceMigrationMarkerKey('us-west-2'))).toBe(true);
        expect(new PriceStore(makeMemento().memento, backingFor(dir)).get('us-west-2')).toEqual(legacy);

        const update = profile.spy.update.mock.calls.length;
        await store.migrateLegacy('us-west-2');
        expect(profile.spy.update.mock.calls.length).toBe(update);
    });

    it('keeps a newer shared table and only marks the old Profile as migrated', async () => {
        const dir = storageDir();
        const backing = backingFor(dir);
        const newer = table('us-west-2', '2026-11-20T00:00:00Z');
        await backing.writeRegion('us-west-2', () => newer);
        const profile = makeMemento({ 'prices:us-west-2': legacy });
        const store = new PriceStore(profile.memento, backing);

        expect(store.get('us-west-2')).toEqual(newer);
        await store.migrateLegacy('us-west-2');
        expect(store.get('us-west-2')).toEqual(newer);
        expect(profile.values.get(priceMigrationMarkerKey('us-west-2'))).toBe(true);
    });

    it('does not mark anything migrated and keeps the old table when shared storage is unavailable', async () => {
        const profile = makeMemento({ 'prices:us-west-2': legacy });
        await new PriceStore(profile.memento).migrateLegacy('us-west-2');
        expect(profile.spy.update).not.toHaveBeenCalled();
        expect(profile.values.get('prices:us-west-2')).toEqual(legacy);
    });

    it('ignores invalid region formats during migration without writing markers to globalState', async () => {
        const profile = makeMemento();
        const store = new PriceStore(profile.memento, backingFor(storageDir()));
        await store.migrateLegacy('../evil');
        await store.migrateLegacy('not-a-region');
        expect(profile.spy.update).not.toHaveBeenCalled();
    });
});
