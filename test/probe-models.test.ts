import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resultFile = pathToFileURL(resolve(__dirname, '../.tmp/probe-models-results.txt'));

const mocks = vi.hoisted(() => ({
    mkdir: vi.fn(),
    write: vi.fn(),
    fetchModelSources: vi.fn(),
    runtimeSend: vi.fn(),
    runtimeDestroy: vi.fn(),
    credentials: vi.fn(),
    fromIni: vi.fn(),
    resolveModels: vi.fn(),
}));

vi.mock('node:fs', () => ({ mkdirSync: mocks.mkdir, writeFileSync: mocks.write }));
// Unit-test placeholders are not AWS configuration; every SDK and credential call is replaced below.
vi.mock('node:util', () => ({ parseArgs: () => ({ values: { profile: '<profile>', region: '<region>', scope: 'geo' } }) }));
vi.mock('@aws-sdk/credential-providers', () => ({ fromIni: mocks.fromIni }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
    BedrockRuntimeClient: class {
        send = mocks.runtimeSend;
        destroy = mocks.runtimeDestroy;
    },
    ConverseStreamCommand: class { constructor(readonly input: unknown) { } },
}));
vi.mock('../src/modelList.ts', () => ({ fetchModelSources: mocks.fetchModelSources }));
vi.mock('../src/models.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/models')>();
    return { ...original, resolveModels: mocks.resolveModels.mockImplementation(original.resolveModels) };
});

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.fetchModelSources.mockReset();
    mocks.runtimeSend.mockReset();
    mocks.fetchModelSources.mockResolvedValue({ region: '<region>', profiles: [], foundations: [], foundationsDenied: false });
    mocks.fromIni.mockReturnValue(mocks.credentials);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

/** Source: user decision (2026-10-21): overwrite .tmp/probe-models-results.txt, separate from task checkpoints. */
describe('probe-models 結果存檔', () => {
    /** User rule: developer probes explicitly use all providers/no generation thresholds, with an empty probe override. */
    it('keeps non-Claude/GPT targets and the explicit all/no-minimum policy', async () => {
        mocks.fetchModelSources.mockResolvedValue({
            region: '<region>', foundationsDenied: false, foundations: [], profiles: [
                { id: 'us.nvidia.uncataloged-tool-model', name: 'NVIDIA unit-test model', active: true },
                { id: 'us.openai.gpt-5.6-luna', name: 'GPT Luna', active: true },
            ]
        });
        mocks.runtimeSend.mockResolvedValue({});
        await import('../scripts/probe-models.mts');
        const args = mocks.resolveModels.mock.calls[0];
        expect(args[3]).toBe(false);
        expect(args[4]).toEqual(new Map());
        expect(args[5]).toEqual({});
        expect(args[6]('future.model')).toBe(true);
        expect(args[6]('openai.gpt-5.6-luna')).toBe(true);
        // Luna's existing image result is skipped; the uncataloged provider is still probed by substitutes only.
        expect(mocks.runtimeSend).toHaveBeenCalledTimes(3);
        expect(mocks.runtimeSend.mock.calls.every(([command]) => command.input.modelId === 'us.nvidia.uncataloged-tool-model')).toBe(true);
        expect(mocks.credentials).not.toHaveBeenCalled();
    });
    it('沒有待測模型時，仍以 UTF-8 覆寫新位置，內容與列印文字一致', async () => {
        await import('../scripts/probe-models.mts');

        expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(new URL('./', resultFile), { recursive: true });
        const printed = vi.mocked(console.log).mock.calls.map(([line]) => line).join('\n');
        expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
            resultFile, `${printed}\n`, 'utf8',
        );
        expect(mocks.fetchModelSources).toHaveBeenCalledExactlyOnceWith(
            '<profile>', '<region>', { onFoundationModelsAccessDenied: 'throw' },
        );
        expect(mocks.runtimeSend).not.toHaveBeenCalled();
        expect(mocks.runtimeDestroy).toHaveBeenCalledOnce();
    });

    it('共用來源查詢失敗時也保存錯誤與登入提示，不發出 runtime 請求', async () => {
        const failure = new Error('unit-test failure');
        failure.name = 'CredentialsProviderError';
        mocks.fetchModelSources.mockRejectedValue(failure);
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

        await expect(import('../scripts/probe-models.mts')).rejects.toThrow('exit');

        expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
            resultFile,
            'Cannot list models: CredentialsProviderError: unit-test failure\nIf SSO has expired, run aws sso login --profile <profile>\n',
            'utf8',
        );
        expect(exit).toHaveBeenCalledWith(1);
        expect(mocks.runtimeSend).not.toHaveBeenCalled();
    });
});