import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate } from '../src/extension';
import { addUsage, currentPeriodStart, isLongContext, nextResetAt, totalInputTokens, type UsagePeriod, UsageStore } from '../src/usage';
import { createSharedUsageBacking, FileSharedUsageBacking, MAX_TIMEOUT_MS, ResetTimer, resolveDefaultProfileStorageDir } from '../src/usageStorage';

/**
 * Expected values come from the user's reset rules (2026-09-26): choose a day from 1 to 31 and a UTC hour;
 * if a month lacks that day, reset on its last day (for example, day 31 becomes February 28 or April 30).
 */

const utc = (s: string) => new Date(`${s}Z`);
const iso = (d: Date) => d.toISOString();
const tokens = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

function makeStorageDir(): string {
    mkdirSync('.tmp', { recursive: true });
    return mkdtempSync(resolve('.tmp', 'bedrock-usage-'));
}

const roots: string[] = [];
const useStorage = () => {
    const root = makeStorageDir();
    roots.push(root);
    return new FileSharedUsageBacking(root);
};
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe('totalInputTokens', () => {
    it('包含未快取輸入、快取讀取與寫入，並將舊資料缺少的快取欄位視為 0', () => {
        expect(totalInputTokens({ inputTokens: 1, cacheReadTokens: 200_000, cacheWriteTokens: 72_000 })).toBe(272_001);
        expect(totalInputTokens({ inputTokens: 10 })).toBe(10);
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
        const store = new UsageStore(memento, useStorage());
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
        const store = new UsageStore(memento, useStorage());
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
        const store = new UsageStore(memento, useStorage());
        const info = { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5', route: 'Global' as const };
        const now = utc('2026-09-27T00:30:00');

        await Promise.all([
            store.record(profile, modelId, info, tokens(12, 1), 1, 0, now),
            store.record(profile, modelId, info, tokens(23, 2), 1, 0, now),
        ]);

        expect(store.get(profile, 1, 0, now).models[modelId]).toMatchObject({ inputTokens: 135, outputTokens: 13, requests: 3 });
    });
});

describe('Shared usage storage across VS Code Profiles', () => {
    const tempDirs: string[] = [];
    const makeTempUserDir = () => {
        const dir = makeStorageDir();
        tempDirs.push(dir);
        return dir;
    };
    const makeMemento = (initial?: Record<string, unknown>) => {
        const values = new Map<string, unknown>(Object.entries(initial ?? {}));
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return values.has(key) ? (values.get(key) as T) : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                values.set(key, value);
            },
        } as unknown as vscode.Memento;
    };

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop();
            if (dir) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it('resolves both Default Profile and named Profile globalStorageUri to the same Default Profile directory, with safe fallback', () => {
        const userDir = makeTempUserDir();
        const extId = 'omoshiroyq.chat-model-provider-for-amazon-bedrock';
        const defaultUri = { scheme: 'file', fsPath: join(userDir, 'globalStorage', extId) };
        const namedProfileUri = { scheme: 'file', fsPath: join(userDir, 'profiles', 'profile-abc123', 'globalStorage', extId) };

        const resolvedDefault = resolveDefaultProfileStorageDir(defaultUri);
        const resolvedNamed = resolveDefaultProfileStorageDir(namedProfileUri);
        expect(resolvedNamed).toBe(resolvedDefault);
        expect(resolvedDefault).toBe(join(userDir, 'globalStorage', extId));

        const warn = vi.fn();
        const info = vi.fn();
        expect(resolveDefaultProfileStorageDir({ scheme: 'vscode-vfs', fsPath: '/virtual/path' }, { info, warn })).toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('local usage will not be recorded');
        expect(resolveDefaultProfileStorageDir({ scheme: 'vscode-userdata', fsPath: join(userDir, 'virtual', extId) })).toBeUndefined();
        if (process.platform === 'win32') {
            expect(resolveDefaultProfileStorageDir({ scheme: 'vscode-userdata', fsPath: `/virtual/globalStorage/${extId}` })).toBeUndefined();
        }

        warn.mockClear();
        const privateUri = { scheme: 'vscode-userdata', authority: 'private-authority', fsPath: join(userDir, 'private-user', 'globalStorage', extId) };
        expect(resolveDefaultProfileStorageDir(privateUri, { info, warn })).toBeUndefined();
        const logged = String(warn.mock.calls[0][0]);
        expect(logged).toContain('local usage will not be recorded');
        expect(logged).not.toContain('private-user');
        expect(logged).not.toContain('private-authority');

        const customFsPath = join(userDir, 'custom-storage', extId);
        expect(resolveDefaultProfileStorageDir({ scheme: 'file', fsPath: customFsPath }, { info, warn })).toBe(customFsPath);
        expect(info).toHaveBeenCalledOnce();
    });

    it('accumulates usage across Default Profile and a named VS Code Profile into one shared file and notifies external watchers', async () => {
        const userDir = makeTempUserDir();
        const extId = 'omoshiroyq.chat-model-provider-for-amazon-bedrock';
        const defaultDir = resolveDefaultProfileStorageDir({ scheme: 'file', fsPath: join(userDir, 'globalStorage', extId) })!;
        const namedDir = resolveDefaultProfileStorageDir({ scheme: 'file', fsPath: join(userDir, 'profiles', 'work-profile', 'globalStorage', extId) })!;
        expect(namedDir).toBe(defaultDir);

        let externalChanged = 0;
        const backingDefault = new FileSharedUsageBacking(defaultDir, () => { externalChanged++; });
        const backingNamed = new FileSharedUsageBacking(namedDir);
        const storeDefault = new UsageStore(makeMemento(), backingDefault);
        const storeNamed = new UsageStore(makeMemento(), backingNamed);

        const info = { name: 'GPT-6.2 Sol', baseId: 'openai.gpt-6.2-sol', route: 'Global' as const };
        const modelId = 'global.openai.gpt-6.2-sol';
        const now = utc('2026-11-20T08:00:00');

        try {
            await storeDefault.record('work', modelId, info, tokens(300, 20), 1, 0, now);
            // Wait past storeDefault's self-write suppression window so storeNamed's write triggers the external watcher.
            await new Promise((r) => setTimeout(r, 200));
            await storeNamed.record('work', modelId, info, tokens(700, 30), 1, 0, now);

            const fromDefault = storeDefault.get('work', 1, 0, now);
            const fromNamed = storeNamed.get('work', 1, 0, now);
            expect(fromDefault.models[modelId]).toMatchObject({ inputTokens: 1_000, outputTokens: 50, requests: 2 });
            expect(fromNamed.models[modelId]).toMatchObject({ inputTokens: 1_000, outputTokens: 50, requests: 2 });

            await new Promise((r) => setTimeout(r, 150));
            expect(externalChanged).toBeGreaterThanOrEqual(1);
        } finally {
            storeDefault.dispose();
            storeNamed.dispose();
        }
    });

    it('serializes shared JSON updates from distinct Node processes and both storage URI schemes', async () => {
        const root = makeTempUserDir();
        const storage = join(root, 'globalStorage', 'diag.extension');
        const named = join(root, 'profiles', 'test', 'globalStorage', 'diag.extension');
        const worker = join(root, 'worker.cjs');
        const compiled = transformSync(readFileSync(join(process.cwd(), 'src', 'usageStorage.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
        writeFileSync(worker, `${compiled}
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const [scheme, fsPath, profile, amount, held, attempted] = process.argv.slice(2);
const backing = module.exports.createSharedUsageBacking({ scheme, fsPath }, () => {}, console);
backing.dispose();
async function run() {
    if (attempted) {
        const limit = Date.now() + 3000;
        while (!fs.existsSync(held)) {
            if (Date.now() >= limit) throw new Error('Writer did not enter the critical section');
            await delay(20);
        }
        fs.writeFileSync(attempted, '');
    }
    await backing.writeProfile(profile, (current) => {
        if (!attempted) {
            fs.writeFileSync(held, '');
            const limit = Date.now() + 3000;
            while (!fs.existsSync(path.join(path.dirname(held), 'attempted'))) {
                if (Date.now() >= limit) throw new Error('Second writer did not arrive');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        }
        return { periodStart: '2026-11-01T00:00:00.000Z', models: { sample: {
            inputTokens: (current?.models.sample.inputTokens ?? 0) + Number(amount),
            requests: (current?.models.sample.requests ?? 0) + 1,
        } } };
    });
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });`);
        const held = join(root, 'held');
        const attempted = join(root, 'attempted');
        const run = promisify(execFile);
        for (const secondProfile of ['sample', 'other']) {
            for (const file of [held, attempted, join(storage, 'shared-usage.json')]) rmSync(file, { force: true });
            const results = await Promise.allSettled([
                run(process.execPath, [worker, 'file', storage, 'sample', '300', held], { timeout: 8_000 }),
                run(process.execPath, [worker, 'vscode-userdata', named, secondProfile, '700', held, attempted], { timeout: 8_000 }),
            ]);
            for (const result of results) if (result.status === 'rejected') throw result.reason;
            const profiles = new FileSharedUsageBacking(storage);
            if (secondProfile === 'sample') {
                expect(profiles.readProfile('sample')?.models.sample).toMatchObject({ inputTokens: 1_000, requests: 2 });
            } else {
                expect(profiles.readProfile('sample')?.models.sample).toMatchObject({ inputTokens: 300, requests: 1 });
                expect(profiles.readProfile('other')?.models.sample).toMatchObject({ inputTokens: 700, requests: 1 });
            }
        }
    }, 18_000);

    it.each(['reset-first', 'record-first'])('preserves the order of reset and record across backings: %s', async (order) => {
        const root = makeTempUserDir();
        const dir = join(root, 'globalStorage', 'diag.extension');
        const first = new UsageStore(makeMemento(), createSharedUsageBacking({ scheme: 'file', fsPath: dir }, () => {}, console));
        const second = new UsageStore(makeMemento(), createSharedUsageBacking({ scheme: 'vscode-userdata', fsPath: join(root, 'profiles', 'test', 'globalStorage', 'diag.extension') }, () => {}, console));
        const now = utc('2026-11-20T08:00:00');
        const info = { name: 'Sample', baseId: 'sample', route: 'Geo' as const };
        const record = (store: UsageStore, input: number) => store.record('sample', 'sample', info, tokens(input, 1), 1, 0, now);
        const reset = () => first.reset('sample', 1, 0, now);
        try {
            await record(first, 300);
            if (order === 'reset-first') {
                await reset();
                await record(second, 700);
                expect(first.get('sample', 1, 0, now).models.sample?.inputTokens).toBe(700);
            } else {
                await record(second, 700);
                expect(first.get('sample', 1, 0, now).models.sample?.inputTokens).toBe(1_000);
                await reset();
                expect(second.get('sample', 1, 0, now).models).toEqual({});
            }
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it('preserves version 1 data and releases the lock when a mutation fails', async () => {
        const root = makeTempUserDir();
        const backing = new FileSharedUsageBacking(root);
        const now = utc('2026-11-20T08:00:00');
        const initial = { version: 1, profiles: { sample: { periodStart: now.toISOString(), models: {} } } };
        const payload = JSON.stringify(initial);
        writeFileSync(backing.path, payload);
        await expect(backing.writeProfile('sample', () => { throw new Error('Synthetic mutation failure'); })).rejects.toThrow('Synthetic mutation failure');
        expect(readFileSync(backing.path, 'utf8')).toBe(payload);
        await expect(backing.writeProfile('sample', (current) => ({ ...current!, manualResetAt: now.toISOString() }))).resolves.toMatchObject({ manualResetAt: now.toISOString() });
    });

    it('recovers after the writer exits and does not overwrite data when locking is unavailable', async () => {
        const backing = new FileSharedUsageBacking(makeTempUserDir());
        const now = utc('2026-11-20T08:00:00');
        const info = { name: 'Sample', baseId: 'sample', route: 'Geo' as const };
        const store = new UsageStore(makeMemento(), backing);
        const record = (amount: number) => store.record('sample', 'sample', info, tokens(amount, 1), 1, 0, now);
        await record(300);
        const payload = readFileSync(backing.path, 'utf8');
        const run = promisify(execFile);
        await run(process.execPath, ['-e', `
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(process.argv[1]);
            db.exec('BEGIN IMMEDIATE');
            process.exit(0);
        `, `${backing.path}.lock.sqlite`]);
        const builtin = process.getBuiltinModule;
        const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation((name: string) => name === 'node:sqlite' ? undefined : builtin(name));
        try {
            await expect(record(700)).rejects.toThrow('Shared usage locking is unavailable');
            expect(readFileSync(backing.path, 'utf8')).toBe(payload);
        } finally {
            spy.mockRestore();
        }
        expect(store.get('sample', 1, 0, now).models.sample?.inputTokens).toBe(300);
        await record(700);
        expect(store.get('sample', 1, 0, now).models.sample).toMatchObject({ inputTokens: 1_000, requests: 2 });
    });

    it('keeps the existing document unchanged while a live connection holds the lock', async () => {
        const backing = new FileSharedUsageBacking(makeTempUserDir());
        const { DatabaseSync } = await import('node:sqlite');
        const lock = new DatabaseSync(`${backing.path}.lock.sqlite`);
        const payload = '{"version":1,"profiles":{}}';
        writeFileSync(backing.path, payload);
        const mutate = vi.fn();
        try {
            lock.exec('BEGIN IMMEDIATE');
            await expect(backing.writeProfile('sample', mutate)).rejects.toThrow('Timed out waiting for the shared usage lock');
            expect(mutate).not.toHaveBeenCalled();
            expect(readFileSync(backing.path, 'utf8')).toBe(payload);
        } finally {
            lock.close();
        }
    }, 8_000);

    it('does not record unavailable storage into globalState or the old shared file', async () => {
        const root = makeTempUserDir();
        const old = join(root, 'shared-usage.json');
        const payload = '{"version":1,"profiles":{}}';
        writeFileSync(old, payload);
        const log = { info: vi.fn(), warn: vi.fn() };
        const memento = makeMemento();
        const store = new UsageStore(memento, createSharedUsageBacking({ scheme: 'vscode-userdata', authority: 'remote', fsPath: root }, () => {}, log));
        const now = utc('2026-11-20T08:00:00');
        await store.record('work', 'sample', { name: 'Sample', baseId: 'sample', route: 'Geo' }, tokens(700, 20), 1, 0, now);
        expect(store.get('work', 1, 0, now).models).toEqual({});
        expect(memento.get('usage:work')).toBeUndefined();
        expect(readFileSync(old, 'utf8')).toBe(payload);
        expect(log.warn).toHaveBeenCalledOnce();
    });

    it('migrates unexpired current-period globalState once without double counting on subsequent startups', async () => {
        const userDir = makeTempUserDir();
        const storageDir = join(userDir, 'globalStorage', 'omoshiroyq.chat-model-provider-for-amazon-bedrock');
        const modelId = 'us.openai.gpt-6.2-sol';
        const info = { name: 'GPT-6.2 Sol', baseId: 'openai.gpt-6.2-sol', route: 'Geo' as const };
        const now = utc('2026-11-20T08:00:00');
        const memento = makeMemento({
            'usage:work': {
                periodStart: '2026-11-01T00:00:00.000Z',
                resetSchedule: { day: 1, hour: 0, nextResetAt: '2026-12-01T00:00:00.000Z' },
                models: {
                    [modelId]: { ...info, inputTokens: 500, outputTokens: 40, requests: 1 },
                },
            } satisfies UsagePeriod,
        });

        const firstStore = new UsageStore(memento, new FileSharedUsageBacking(storageDir));
        await firstStore.configureResetSchedule('work', 1, 0, now);
        expect(firstStore.get('work', 1, 0, now).models[modelId]).toMatchObject({ inputTokens: 500, outputTokens: 40, requests: 1 });
        firstStore.dispose();

        // Re-opening the same VS Code Profile must not re-import or double-count legacy globalState.
        const secondStore = new UsageStore(memento, new FileSharedUsageBacking(storageDir));
        await secondStore.configureResetSchedule('work', 1, 0, now);
        await secondStore.record('work', modelId, info, tokens(200, 10), 1, 0, now);
        expect(secondStore.get('work', 1, 0, now).models[modelId]).toMatchObject({ inputTokens: 700, outputTokens: 50, requests: 2 });
        secondStore.dispose();
    });
});

describe('ResetTimer and status-bar/panel auto reset', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('segments waits longer than 24.85 days without premature firing and fires once at target time', () => {
        vi.useFakeTimers({ now: Date.parse('2026-12-01T00:00:00.000Z') });
        let fired = 0;
        const timer = new ResetTimer(() => { fired++; });
        // 31 days > MAX_TIMEOUT_MS (~24.85 days)
        timer.schedule(new Date('2027-01-01T00:00:00.000Z'));

        vi.advanceTimersByTime(MAX_TIMEOUT_MS);
        expect(fired).toBe(0);

        vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000 - MAX_TIMEOUT_MS - 1);
        expect(fired).toBe(0);

        vi.advanceTimersByTime(1);
        expect(fired).toBe(1);
        timer.dispose();
    });

    it('resets both status bar and open usage panel when the reset point arrives or when showUsage runs after due time', async () => {
        vi.useFakeTimers({ now: Date.parse('2026-11-30T23:59:50.000Z') });
        const tempDir = mkdtempSync(join(tmpdir(), 'bedrock-ext-reset-'));
        const statusItems: Array<{ text: string; tooltip: string }> = [];
        const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
        let webviewHtml = '';
        let configValues: Record<string, unknown> = {
            profile: 'work',
            region: 'us-west-2',
            usageResetDay: 1,
            usageResetHour: 0,
        };
        const configListeners: Array<(e: { affectsConfiguration(section: string): boolean }) => void> = [];

        vi.spyOn(vscode.window, 'createStatusBarItem').mockImplementation(() => {
            const item = { name: '', text: '', tooltip: '', command: '', backgroundColor: undefined, show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
            statusItems.push(item);
            return item as unknown as vscode.StatusBarItem;
        });
        vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation(() => ({
            reveal: vi.fn(),
            onDidDispose: vi.fn(() => ({ dispose() { } })),
            dispose: vi.fn(),
            webview: {
                cspSource: 'vscode-webview:',
                get html() { return webviewHtml; },
                set html(v: string) { webviewHtml = v; },
                onDidReceiveMessage: vi.fn(() => ({ dispose() { } })),
            },
        }) as unknown as vscode.WebviewPanel);
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id: string, cb: (...args: unknown[]) => unknown) => {
            registeredCommands.set(id, cb);
            return { dispose() { } };
        });
        vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(() => ({
            get: <T>(key: string): T | undefined => configValues[key] as T | undefined,
            inspect: () => undefined,
            update: async () => undefined,
            has: () => false,
        }) as unknown as vscode.WorkspaceConfiguration);
        vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation((listener: unknown) => {
            configListeners.push(listener as (e: { affectsConfiguration(section: string): boolean }) => void);
            return { dispose() { } };
        });

        const modelId = 'us.openai.gpt-6.2-sol';
        const stateMap = new Map<string, unknown>([
            ['usage:work', {
                periodStart: '2026-11-01T00:00:00.000Z',
                resetSchedule: { day: 1, hour: 0, nextResetAt: '2026-12-01T00:00:00.000Z' },
                models: {
                    [modelId]: {
                        name: 'GPT-6.2 Sol',
                        baseId: 'openai.gpt-6.2-sol',
                        route: 'Geo',
                        inputTokens: 2_440_000,
                        outputTokens: 1_300,
                        requests: 10,
                    },
                },
            } satisfies UsagePeriod],
        ]);
        const subscriptions: Array<{ dispose(): unknown }> = [];
        const context = {
            subscriptions,
            globalStorageUri: { scheme: 'file', fsPath: join(tempDir, 'globalStorage', 'omoshiroyq.chat-model-provider-for-amazon-bedrock') },
            globalState: {
                get: <T>(k: string, def?: T) => (stateMap.has(k) ? (stateMap.get(k) as T) : def),
                update: async (k: string, v: unknown) => { stateMap.set(k, v); },
            },
        } as unknown as vscode.ExtensionContext;

        try {
            activate(context);
            await vi.advanceTimersByTimeAsync(0);

            const tokenBarItem = statusItems[0]!;
            expect(tokenBarItem.text).toBe('$(hubot) 2.44M / 1.3K');

            // Open the usage panel before reset
            await registeredCommands.get('amazonBedrockProvider.showUsage')?.();
            expect(webviewHtml).toContain('2,440,000');

            // Advance across 2026-12-01T00:00:00.000Z -> timer fires automatically without Reload Window
            await vi.advanceTimersByTimeAsync(10_000);
            expect(tokenBarItem.text).toBe('$(hubot) 0 / 0');
            expect(webviewHtml).toContain('No usage in this period yet.');

            // Also verify changing usageResetDay/usageResetHour reschedules the timer cleanly
            configValues = { ...configValues, usageResetDay: 2, usageResetHour: 0 };
            for (const listener of configListeners) {
                listener({ affectsConfiguration: (s) => s === 'amazonBedrockProvider' });
            }
            await vi.advanceTimersByTimeAsync(0);
            expect(tokenBarItem.text).toBe('$(hubot) 0 / 0');
        } finally {
            for (const sub of subscriptions) {
                sub.dispose();
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('keeps an open usage panel current while another VS Code Profile writes the shared file', async () => {
        const root = makeStorageDir();
        roots.push(root);
        const extId = 'diag.extension';
        let webviewHtml = '';

        vi.spyOn(vscode.window, 'createStatusBarItem').mockImplementation(() => ({ name: '', text: '', tooltip: '', command: '', backgroundColor: undefined, show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }) as unknown as vscode.StatusBarItem);
        vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation(() => ({
            reveal: vi.fn(),
            onDidDispose: vi.fn(() => ({ dispose() { } })),
            dispose: vi.fn(),
            webview: {
                cspSource: 'vscode-webview:',
                get html() { return webviewHtml; },
                set html(v: string) { webviewHtml = v; },
                onDidReceiveMessage: vi.fn(() => ({ dispose() { } })),
            },
        }) as unknown as vscode.WebviewPanel);
        const registered = new Map<string, (...args: unknown[]) => unknown>();
        vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id: string, cb: (...args: unknown[]) => unknown) => {
            registered.set(id, cb);
            return { dispose() { } };
        });
        vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(() => ({
            get: <T>(key: string): T | undefined => ({ profile: 'work', region: 'us-west-2', usageResetDay: 1, usageResetHour: 0 } as Record<string, unknown>)[key] as T | undefined,
            inspect: () => undefined,
            update: async () => undefined,
            has: () => false,
        }) as unknown as vscode.WorkspaceConfiguration);
        vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation(() => ({ dispose() { } }));

        const subscriptions: Array<{ dispose(): unknown }> = [];
        const context = {
            subscriptions,
            globalStorageUri: { scheme: 'vscode-userdata', fsPath: join(root, 'globalStorage', extId) },
            globalState: { get: <T>(_k: string, def?: T) => def, update: async () => undefined },
        } as unknown as vscode.ExtensionContext;
        const log = { info: vi.fn(), warn: vi.fn() };
        try {
            activate(context);
            await registered.get('amazonBedrockProvider.showUsage')?.();
            expect(webviewHtml).toContain('No usage in this period yet.');
            const other = new UsageStore(
                { get: <T>(_k: string, def?: T) => def, update: async () => undefined } as unknown as vscode.Memento,
                createSharedUsageBacking({ scheme: 'vscode-userdata', fsPath: join(root, 'profiles', 'abc', 'globalStorage', extId) }, () => { }, log),
            );
            try {
                await other.record('work', 'sample', { name: 'Sample', baseId: 'sample', route: 'Geo' }, tokens(1_234, 56), 1, 0, new Date());
                await vi.waitFor(() => expect(webviewHtml).toContain('1,234'));
            } finally {
                other.dispose();
            }
        } finally {
            for (const sub of subscriptions) {
                sub.dispose();
            }
        }
    });
});
