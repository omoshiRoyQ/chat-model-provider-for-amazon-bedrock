import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { addUsage, currentPeriodStart, isLongContext, nextResetAt, type UsagePeriod, UsageStore } from '../src/usage';

/**
 * Expected values come from the user's reset rules (2026-09-26): choose a day from 1 to 31 and a UTC hour;
 * if a month lacks that day, reset on its last day (for example, day 31 becomes February 28 or April 30).
 */

const utc = (s: string) => new Date(`${s}Z`);
const iso = (d: Date) => d.toISOString();
const tokens = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

describe('currentPeriodStart / nextResetAt', () => {
    it('預設每月 1 號 00:00 UTC', () => {
        const now = utc('2026-09-26T08:00:00');
        expect(iso(currentPeriodStart(now, 1, 0))).toBe('2026-09-01T00:00:00.000Z');
        expect(iso(nextResetAt(now, 1, 0))).toBe('2026-10-01T00:00:00.000Z');
    });

    it('還沒到本月重設點時，週期從上個月開始', () => {
        const now = utc('2026-09-10T00:00:00');
        expect(iso(currentPeriodStart(now, 15, 9))).toBe('2026-08-15T09:00:00.000Z');
        expect(iso(nextResetAt(now, 15, 9))).toBe('2026-09-15T09:00:00.000Z');
    });

    it('剛好在重設時間點時算新的一期', () => {
        expect(iso(currentPeriodStart(utc('2026-09-15T09:00:00'), 15, 9))).toBe('2026-09-15T09:00:00.000Z');
    });

    it('設 31 號：2 月在 28 號、4 月在 30 號重設', () => {
        expect(iso(nextResetAt(utc('2027-01-31T12:00:00'), 31, 0))).toBe('2027-02-28T00:00:00.000Z');
        expect(iso(nextResetAt(utc('2026-03-31T12:00:00'), 31, 0))).toBe('2026-04-30T00:00:00.000Z');
        expect(iso(currentPeriodStart(utc('2027-03-10T00:00:00'), 31, 0))).toBe('2027-02-28T00:00:00.000Z');
    });

    it('閏年 2 月有 29 號', () => {
        expect(iso(nextResetAt(utc('2028-01-31T12:00:00'), 31, 0))).toBe('2028-02-29T00:00:00.000Z');
    });

    it('跨年：1 月還沒到重設點時，週期從前一年 12 月開始', () => {
        expect(iso(currentPeriodStart(utc('2027-01-05T00:00:00'), 20, 0))).toBe('2026-12-20T00:00:00.000Z');
    });
});

describe('addUsage', () => {
    it('同一個 model ID 累加，Geo 與 Global 分開計', () => {
        const info = { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5' };
        let p: UsagePeriod = { periodStart: 'x', models: {} };
        p = addUsage(p, 'us.anthropic.claude-opus-5-5', { ...info, route: 'Geo' }, tokens(100, 10));
        p = addUsage(p, 'us.anthropic.claude-opus-5-5', { ...info, route: 'Geo' }, tokens(50, 5));
        p = addUsage(p, 'global.anthropic.claude-opus-5-5', { ...info, route: 'Global' }, tokens(1, 1));
        expect(p.models['us.anthropic.claude-opus-5-5']).toMatchObject({ inputTokens: 150, outputTokens: 15, requests: 2 });
        expect(p.models['global.anthropic.claude-opus-5-5']).toMatchObject({ inputTokens: 1, requests: 1, route: 'Global' });
    });

    it('快取 token 分開累加；舊資料沒有快取欄位時當 0', () => {
        // Usage values: GPT-6.1 Sol metadata.usage observed by the user on 2026-10-03.
        const info = { name: 'GPT', baseId: 'openai.test', route: 'Geo' as const };
        const legacy: UsagePeriod = { periodStart: 'x', models: { m: { ...info, inputTokens: 10, outputTokens: 1, requests: 1 } } };
        const p = addUsage(legacy, 'm', info, tokens(2, 20, 0, 19001));
        expect(p.models.m).toMatchObject({ inputTokens: 12, outputTokens: 21, cacheReadTokens: 0, cacheWriteTokens: 19001, requests: 2 });
    });

    it('long-context 請求同時計入總計與 longContext 子計；一般請求保留既有子計', () => {
        const info = { name: 'GPT', baseId: 'openai.test', route: 'Geo' as const };
        let p: UsagePeriod = { periodStart: 'x', models: {} };
        p = addUsage(p, 'm', info, tokens(300_000, 10, 0, 0), true);
        p = addUsage(p, 'm', info, tokens(100, 1));
        expect(p.models.m).toMatchObject({ inputTokens: 300_100, outputTokens: 11, requests: 2 });
        expect(p.models.m.longContext).toEqual({ inputTokens: 300_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 });
    });
});

/**
 * Threshold 272,000 comes from the GPT model cards ("more than 272K input tokens", 2026-10-04). Counting cache tokens toward it
 * follows the AWS prompt-caching definition of total input; user decision (2026-10-04): overestimating beats underestimating.
 */
describe('isLongContext', () => {
    it('總輸入（含快取讀取與寫入）超過門檻才算', () => {
        expect(isLongContext(tokens(272_000, 0), 272_000)).toBe(false);
        expect(isLongContext(tokens(1, 0, 200_000, 72_000), 272_000)).toBe(true);
        expect(isLongContext(tokens(1_000_000, 0), undefined)).toBe(false);
    });
});

describe('UsageStore reset schedule', () => {
    it('設定新時間後保留既有統計，重設後的新請求繼續累計', async () => {
        const values = new Map<string, unknown>();
        const memento = {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return values.has(key) ? (values.get(key) as T) : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                values.set(key, value);
            },
        } as unknown as vscode.Memento;
        const store = new UsageStore(memento);
        const profile = 'test-profile';
        const modelId = 'global.anthropic.claude-opus-5-5';
        const info = { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5', route: 'Global' as const };

        await store.record(profile, modelId, info, tokens(120, 12), 1, 0, utc('2026-09-26T08:00:00'));
        await store.configureResetSchedule(profile, 27, 1, utc('2026-09-27T00:09:10'));

        const beforeReset = store.get(profile, 27, 1, utc('2026-09-27T00:59:59'));
        expect(beforeReset.models[modelId]).toMatchObject({ inputTokens: 120, outputTokens: 12, requests: 1 });
        expect(beforeReset.resetSchedule?.nextResetAt).toBe('2026-09-27T01:00:00.000Z');

        const atReset = store.get(profile, 27, 1, utc('2026-09-27T01:00:00'));
        expect(atReset.periodStart).toBe('2026-09-27T01:00:00.000Z');
        expect(atReset.models).toEqual({});

        await store.record(profile, modelId, info, tokens(5, 2), 27, 1, utc('2026-09-27T01:00:01'));
        const afterReset = store.get(profile, 27, 1, utc('2026-09-27T01:05:00'));
        expect(afterReset.models[modelId]).toMatchObject({ inputTokens: 5, outputTokens: 2, requests: 1 });
        expect(afterReset.resetSchedule?.nextResetAt).toBe('2026-10-27T01:00:00.000Z');
    });

    it('手動重設立即清空資料，並保留下一個排程重設點', async () => {
        const values = new Map<string, unknown>();
        const memento = {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return values.has(key) ? (values.get(key) as T) : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                values.set(key, value);
            },
        } as unknown as vscode.Memento;
        const store = new UsageStore(memento);
        const profile = 'test-profile';
        const modelId = 'global.anthropic.claude-opus-5-5';
        const info = { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5', route: 'Global' as const };
        const beforeReset = utc('2026-09-27T00:30:00');

        await store.record(profile, modelId, info, tokens(10, 3), 27, 1, beforeReset);
        await store.reset(profile, 27, 1, beforeReset);

        const period = store.get(profile, 27, 1, beforeReset);
        expect(period.models).toEqual({});
        expect(period.resetSchedule?.nextResetAt).toBe('2026-09-27T01:00:00.000Z');
        expect(period.manualResetAt).toBe(beforeReset.toISOString());
    });
});

/** Expected behavior comes from the UsageStore accumulation contract: every concurrent successful request counts in the same period. */
describe('UsageStore concurrent writes', () => {
    it('保留同一 profile 的並行 token 累計統計', async () => {
        const profile = 'test-profile';
        const modelId = 'global.anthropic.claude-opus-5-5';
        const values = new Map<string, unknown>([[`usage:${profile}`, {
            periodStart: '2026-09-01T00:00:00.000Z',
            resetSchedule: { day: 1, hour: 0, nextResetAt: '2026-10-01T00:00:00.000Z' },
            models: {
                [modelId]: {
                    name: 'Claude Opus 5.5',
                    baseId: 'anthropic.claude-opus-5-5',
                    route: 'Global',
                    inputTokens: 100,
                    outputTokens: 10,
                    requests: 1,
                },
            },
        }]]);
        const memento = {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return values.has(key) ? (values.get(key) as T) : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                await Promise.resolve();
                values.set(key, value);
            },
        } as unknown as vscode.Memento;
        const store = new UsageStore(memento);
        const info = { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5', route: 'Global' as const };
        const now = utc('2026-09-27T00:30:00');

        await Promise.all([
            store.record(profile, modelId, info, tokens(12, 1), 1, 0, now),
            store.record(profile, modelId, info, tokens(23, 2), 1, 0, now),
        ]);

        expect(store.get(profile, 1, 0, now).models[modelId]).toMatchObject({ inputTokens: 135, outputTokens: 13, requests: 3 });
    });
});
