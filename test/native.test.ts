import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { NativeConverseClient, parseToolInput } from '../src/native';
import { ProxyAwareHttpHandler } from '../src/proxy';

// Transport selection and cache invalidation are required by the proxy-fix specification.
describe('NativeConverseClient transport', () => {
    const clients: BedrockRuntimeClient[] = [];
    const info = vi.fn();
    const log = { info } as unknown as vscode.LogOutputChannel;
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken;
    const params = { profile: 'test-profile', region: 'test-region', modelId: 'test', messages: [], toolConfig: undefined };

    beforeEach(() => {
        for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) {
            vi.stubEnv(name, '');
        }
        vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(function (this: BedrockRuntimeClient) {
            clients.push(this);
            return Promise.resolve({ stream: (async function* () { yield { contentBlockDelta: { delta: { text: 'hello' } } }; })() }) as never;
        });
    });

    afterEach(() => {
        for (const client of new Set(clients)) {
            client.destroy();
        }
        clients.length = 0;
        info.mockClear();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('keeps the SDK default HTTP/2 handler when no proxy is configured', async () => {
        await new NativeConverseClient(log).stream(params, () => undefined, token);
        expect(clients[0]?.config.requestHandler).toBeInstanceOf(NodeHttp2Handler);
        expect(clients[0]?.config.requestHandler).not.toBeInstanceOf(ProxyAwareHttpHandler);
        expect(clients[0]?.middlewareStack.identify().join()).not.toContain('proxyHostHeaderMiddleware');
        expect(info).toHaveBeenCalledWith(expect.stringMatching(/proxy=off$/));
    });

    it('installs a proxy-aware handler without changing streamed content', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://user:secret@proxy.example.test:3128');
        const parts: object[] = [];
        await new NativeConverseClient(log).stream(params, part => parts.push(part), token);
        expect(clients[0]?.config.requestHandler).toBeInstanceOf(ProxyAwareHttpHandler);
        expect(clients[0]?.middlewareStack.identify().join()).toContain('proxyHostHeaderMiddleware');
        expect(parts).toEqual([{ kind: 'text', text: 'hello' }]);
        expect(info).toHaveBeenCalledWith(expect.stringMatching(/proxy=on$/));
        expect(JSON.stringify(info.mock.calls)).not.toMatch(/user|secret|proxy\.example/);
    });

    it('reuses an unchanged client and rebuilds it when proxy settings or NO_PROXY change', async () => {
        const destroy = vi.spyOn(BedrockRuntimeClient.prototype, 'destroy');
        const client = new NativeConverseClient(log);
        await client.stream(params, () => undefined, token);
        await client.stream(params, () => undefined, token);
        expect(clients[0]).toBe(clients[1]);
        vi.stubEnv('https_proxy', 'http://proxy.example.test:3128');
        await client.stream(params, () => undefined, token);
        expect(clients[2]).not.toBe(clients[1]);
        vi.stubEnv('no_proxy', '*');
        await client.stream(params, () => undefined, token);
        expect(clients[3]).not.toBe(clients[2]);
        vi.stubEnv('https_proxy', '');
        await client.stream(params, () => undefined, token);
        expect(clients[4]?.config.requestHandler).not.toBeInstanceOf(ProxyAwareHttpHandler);
        expect(destroy).toHaveBeenCalledTimes(3);
    });
});

/**
 * Usage values are the metadata.usage objects the user observed on 2026-10-03.
 * Field meaning comes from AWS prompt-caching.html: total input = inputTokens + cacheReadInputTokens + cacheWriteInputTokens.
 */
describe('NativeConverseClient usage', () => {
    async function usageOf(raw: Record<string, number>) {
        const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue({
            stream: (async function* () {
                yield { metadata: { usage: raw } };
            })(),
        } as never);
        const log = { info: vi.fn() } as unknown as vscode.LogOutputChannel;
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken;
        try {
            return await new NativeConverseClient(log).stream({ profile: 'p', region: 'us-west-2', modelId: 'm', messages: [], toolConfig: undefined }, () => undefined, token);
        } finally {
            send.mockRestore();
        }
    }

    it('讀取 GPT-6.1 Sol 回傳的快取寫入 token', async () => {
        const usage = await usageOf({ inputTokens: 2, outputTokens: 20, totalTokens: 19023, cacheReadInputTokens: 0, cacheWriteInputTokens: 19001 });
        expect(usage).toEqual({ inputTokens: 2, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 19001 });
    });

    it('沒有快取欄位時（Claude Sonnet 5.5 實測）當 0', async () => {
        const usage = await usageOf({ inputTokens: 32834, outputTokens: 23, totalTokens: 32857 });
        expect(usage).toEqual({ inputTokens: 32834, outputTokens: 23, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
});

/** stopReason=max_tokens with outputTokens=4096 was observed from Claude Haiku 5.5 on 2026-10-09 (user log). */
describe('NativeConverseClient stop reason', () => {
    it('寫 warn log 並附上送出的 maxTokens', async () => {
        const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue({
            stream: (async function* () {
                yield { messageStop: { stopReason: 'max_tokens' } };
            })(),
        } as never);
        const log = { info: vi.fn(), warn: vi.fn() } as unknown as vscode.LogOutputChannel;
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken;
        try {
            await new NativeConverseClient(log).stream({ profile: 'p', region: 'us-west-2', modelId: 'm', messages: [], toolConfig: undefined, maxTokens: 128_000 }, () => undefined, token);
        } finally {
            send.mockRestore();
        }
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/stopReason=max_tokens, maxTokens=128000$/));
    });
});

/**
 * Expected values come from the user's decision (2026-09-29): parse errors must not include the raw tool input,
 * because it is chat-derived content and README states that logs never contain chat content.
 */

describe('parseToolInput', () => {
    it('JSON 不完整時，錯誤訊息只含 tool 名稱與長度，不含原始內容', () => {
        const raw = '{"filePath":"config.ts","content":"export const DB_PASSWORD = \'hunter2\';';
        const parse = () => parseToolInput(raw, 'create_file');
        expect(parse).toThrow(/^Failed to parse input for tool "create_file": /);
        expect(parse).toThrow(new RegExp(`; length=${raw.length}$`));
        expect(parse).not.toThrow(/hunter2|config\.ts/);
    });

    it('JSON 不是物件時，錯誤訊息同樣不含原始內容', () => {
        expect(() => parseToolInput('"secret-value"', 'run')).toThrow(/length=14$/);
        expect(() => parseToolInput('"secret-value"', 'run')).not.toThrow(/secret-value/);
    });

    it('空字串視為沒有參數的 tool，回傳空物件', () => {
        expect(parseToolInput('  ', 'noop')).toEqual({});
    });
});
