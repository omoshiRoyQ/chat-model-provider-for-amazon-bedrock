import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import * as proxy from '../src/proxy';
import { PriceStore } from '../src/priceStore';

const memento = { get: vi.fn(), update: vi.fn() } as unknown as vscode.Memento;

afterEach(() => vi.restoreAllMocks());

/** Expected behavior comes from the security review (2026-10-09) and proxyUrl decision (2026-11-19): a price download must bound timeout and pass proxyUrl. */
describe('PriceStore.download', () => {
    it('passes a 60-second timeout and proxyUrl to fetchHttpsText', async () => {
        const fetchSpy = vi.spyOn(proxy, 'fetchHttpsText').mockRejectedValue(new Error('HTTP 503 Unavailable'));
        await expect(new PriceStore(memento).download('us-west-2', 'http://proxy.example:8080')).rejects.toThrow('HTTP 503');
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/us-west-2/index.json'),
            { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024, proxyUrl: 'http://proxy.example:8080' },
        );
    });

    it('拒絕不合格式的 region，不發出請求', async () => {
        const fetchSpy = vi.spyOn(proxy, 'fetchHttpsText');
        await expect(new PriceStore(memento).download('../evil')).rejects.toThrow('Invalid AWS region format');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
