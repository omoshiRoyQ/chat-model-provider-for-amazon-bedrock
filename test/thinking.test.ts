import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { buildThinkingRequest } from '../src/thinking';
import { ThinkingStore } from '../src/thinkingStore';

/**
 * Expected values come from parameter formats verified with Converse on 2026-09-26 (see comments in src/thinking.ts)
 * and AWS documentation limits (`budget_tokens` must be at least 1024 and cannot be combined with toolChoice any).
 */

describe('buildThinkingRequest', () => {
    it('effort=default 或模型不支援 thinking 時不送任何參數', () => {
        expect(buildThinkingRequest('adaptive', 'default', 128_000, false)).toEqual({});
        expect(buildThinkingRequest('none', 'high', 4_000, false)).toEqual({});
    });

    describe('extended（budget_tokens）', () => {
        it('依 effort 設定 budget，並明確帶 maxTokens', () => {
            expect(buildThinkingRequest('extended', 'low', 64_000, false)).toEqual({
                fields: { thinking: { type: 'enabled', budget_tokens: 2_048 } },
                maxTokens: 64_000,
                note: undefined,
            });
        });

        it('budget 最多占輸出上限的一半', () => {
            const r = buildThinkingRequest('extended', 'max', 32_000, false);
            expect(r.fields).toEqual({ thinking: { type: 'enabled', budget_tokens: 16_000 } });
            expect(r.note).toMatch(/16000/);
        });

        it('輸出上限的一半不到 1024 時不開 thinking', () => {
            expect(buildThinkingRequest('extended', 'low', 2_000, false).fields).toBeUndefined();
        });

        it('toolChoice any 時不開 thinking', () => {
            expect(buildThinkingRequest('extended', 'high', 64_000, true).fields).toBeUndefined();
        });

        it('off 時不送參數（Claude 的 extended thinking 預設關閉）', () => {
            expect(buildThinkingRequest('extended', 'off', 64_000, false)).toEqual({});
        });
    });

    describe('adaptive', () => {
        it('送 thinking.adaptive 與 output_config.effort', () => {
            expect(buildThinkingRequest('adaptive', 'high', 128_000, false).fields).toEqual({
                thinking: { type: 'adaptive' },
                output_config: { effort: 'high' },
            });
        });

        it('可關閉的模型：off 送 thinking.disabled（Sonnet 4.6 實測成功）', () => {
            expect(buildThinkingRequest('adaptive', 'off', 64_000, false).fields).toEqual({ thinking: { type: 'disabled' } });
        });

        it('不能關閉的模型：off 改送 effort=low（Opus 5.5 實測 disabled 被拒）', () => {
            const r = buildThinkingRequest('adaptiveAlways', 'off', 128_000, false);
            expect(r.fields).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
            expect(r.note).toBeDefined();
        });
    });

    describe('openai（reasoning.effort）', () => {
        it('送 reasoning.effort', () => {
            expect(buildThinkingRequest('openai', 'medium', 4_096, false).fields).toEqual({ reasoning: { effort: 'medium' } });
        });

        it('接受 none 的模型：off 送 none（GPT-5.6 Luna 實測成功）', () => {
            expect(buildThinkingRequest('openai', 'off', 4_096, false).fields).toEqual({ reasoning: { effort: 'none' } });
        });

        it('不接受 none 的模型：off 改送 low（GPT-6 Astra 實測 none 被拒）', () => {
            const r = buildThinkingRequest('openaiNoNone', 'off', 128_000, false);
            expect(r.fields).toEqual({ reasoning: { effort: 'low' } });
            expect(r.note).toBeDefined();
        });
    });
});

describe('ThinkingStore', () => {
    it('依模型 ID 個別保存 effort，並可一次全部恢復預設', async () => {
        const values = new Map<string, unknown>();
        const memento = {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return values.has(key) ? (values.get(key) as T) : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                values.set(key, value);
            },
        } as unknown as vscode.Memento;
        const store = new ThinkingStore(memento);
        const gpt = 'global.openai.gpt-6-astra';
        const opus = 'global.anthropic.claude-opus-5-5';

        await store.set(gpt, 'high');
        await store.set(opus, 'low');

        expect(store.get(gpt)).toBe('high');
        expect(store.get(opus)).toBe('low');

        await store.resetAll();

        expect(store.get(gpt)).toBe('default');
        expect(store.get(opus)).toBe('default');
    });
});
