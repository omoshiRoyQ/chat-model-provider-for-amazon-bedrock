import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { NativeConverseClient, parseToolInput } from '../src/native';

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
