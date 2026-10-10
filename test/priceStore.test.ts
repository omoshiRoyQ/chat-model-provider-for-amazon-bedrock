import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { PriceStore } from '../src/priceStore';

const memento = { get: vi.fn(), update: vi.fn() } as unknown as vscode.Memento;

afterEach(() => vi.unstubAllGlobals());

/** Expected behavior comes from the security review (2026-10-09): a price download must not hang indefinitely. */
describe('PriceStore.download', () => {
    it('送出帶有 abort signal 的請求', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' });
        vi.stubGlobal('fetch', fetchMock);
        await expect(new PriceStore(memento).download('us-west-2')).rejects.toThrow('HTTP 503');
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
    });

    it('拒絕不合格式的 region，不發出請求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(new PriceStore(memento).download('../evil')).rejects.toThrow('Invalid AWS region format');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
