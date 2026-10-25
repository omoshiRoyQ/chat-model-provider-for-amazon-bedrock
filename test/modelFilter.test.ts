import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { classifyModel, compareVersions, isMinimumVersion, modelVersion, modelVisibility, MODEL_PROVIDERS, parseModelVisibility, pickModelVisibility, readModelVisibility, visibilityCacheKey } from '../src/modelFilter';
import { readSettings } from '../src/settings';

type Scope = { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown };
let visibility: Scope;
let config: vscode.WorkspaceConfiguration;
let update: ReturnType<typeof vi.fn>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const selected = (providers: string[] = ['anthropic', 'xai']) => ({ mode: 'selected', providers, minimumVersions: {} });
const queueSelected = () => {
    vi.mocked(vscode.window.showQuickPick)
        .mockResolvedValueOnce({ mode: 'selected', label: 'Selected providers' } as never)
        .mockResolvedValueOnce([{ key: 'anthropic' }, { key: 'openai' }, { key: 'xai' }] as never)
        .mockResolvedValueOnce({ save: true } as never);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('4.6').mockResolvedValueOnce('6').mockResolvedValueOnce('4.7');
};

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    visibility = {};
    update = vi.fn(async (_key: string, value: unknown, target: vscode.ConfigurationTarget) => {
        visibility = target === vscode.ConfigurationTarget.Workspace ? { workspaceValue: value } : { globalValue: value };
    });
    config = {
        get: vi.fn(() => undefined),
        inspect: vi.fn((key: string) => ({ key, ...(key === 'modelVisibility' ? visibility : {}) })),
        update,
        has: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration;
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(config);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});

/** Expected groups come from existing models.ts/probe fixtures; user decisions separate GPT from GPT-OSS and alias Moonshot. */
describe('model provider and family classification', () => {
    it.each([
        ['anthropic.claude-sonnet-4-6', 'anthropic', 'claude'],
        ['openai.gpt-6-luna', 'openai', 'gpt'],
        ['openai.gpt-oss-120b', 'openai', 'gptOss'],
        ['openai.gpt-oss-safeguard-120b', 'openai', 'gptOssSafeguard'],
        ['xai.grok-4-7', 'xai', 'grok'],
        ['nvidia.nemotron-nano-12b-v2', 'nvidia', 'other'],
        ['moonshot.kimi-k2.5', 'moonshot', 'other'],
        ['moonshotai.kimi-k3', 'moonshot', 'other'],
        ['future.new-model', 'other', 'other'],
        ['', 'other', 'other'],
    ])('classifies foundation ID %s without parsing a generation', (id, provider, family) => {
        expect(classifyModel(id)).toEqual({ provider, family });
    });
    it('keeps unique stable keys beyond the original four example companies', () => {
        expect(new Set(MODEL_PROVIDERS.map(({ key }) => key)).size).toBe(MODEL_PROVIDERS.length);
        expect(MODEL_PROVIDERS.map(({ key }) => key)).toEqual(expect.arrayContaining(['amazon', 'meta', 'mistral', 'moonshot', 'nvidia', 'openai', 'xai']));
    });
});

/** Formats come from catalog/card/probe IDs cited in models.ts; comparisons and unknown retention are user requirements. */
describe('series generation thresholds', () => {
    it.each([
        ['anthropic.claude-3-haiku-20240307-v1:0', [3]],
        ['anthropic.claude-sonnet-4-20250514-v1:0', [4]],
        ['anthropic.claude-haiku-4-5-20251001-v1:0', [4, 5]],
        ['anthropic.claude-opus-4-6-v1', [4, 6]],
        ['anthropic.claude-opus-4-7', [4, 7]],
        ['anthropic.claude-sonnet-5', [5]],
        ['anthropic.claude-fable-5-1', [5, 1]],
        ['openai.gpt-5.6-luna', [5, 6]],
        ['openai.gpt-6-astra', [6]],
        ['openai.gpt-6.1-sol', [6, 1]],
        ['xai.grok-4.6', [4, 6]],
        ['xai.grok-4.7', [4, 7]],
    ])('reads only the generation in %s', (id, version) => expect(modelVersion(id as string)).toEqual(version));
    it.each([
        'anthropic.claude-new-4-7', 'anthropic.claude-sonnet-next-20261023-v1:0',
        'anthropic.claude-sonnet-4-20250514-v2:0', 'anthropic.claude-3-7-sonnet-20250219-v1:0',
        'openai.gpt-6-new-120b', 'openai.gpt-next', 'openai.gpt-6.1-sol-v1:0',
        'openai.gpt-oss-120b-1:0', 'openai.gpt-oss-safeguard-20b',
        'xai.grok-4-7', 'xai.grok-next-v1:0', 'nvidia.nemotron-nano-12b-v2',
        'nvidia.nemotron-nano-3-30b', 'us.openai.gpt-6-luna', 'openai.gpt-6\n', '',
    ])('does not guess generations for %s', (id) => expect(modelVersion(id)).toBeUndefined());
    it.each([
        [[5, 9], [5, 10], -1], [[5, 10], [6], -1], [[6], [6, 0], 0], [[6, 1], [6], 1],
    ])('compares integer sequences %j and %j', (a, b, expected) => expect(compareVersions(a as number[], b as number[])).toBe(expected));
    it.each([
        ['anthropic.claude-haiku-4-5-20251001-v1:0', false, false],
        ['anthropic.claude-opus-4-6-v1', true, false],
        ['anthropic.claude-sonnet-5', true, false],
        ['openai.gpt-5.6-luna', false, false], ['openai.gpt-6-luna', true, false], ['openai.gpt-6.1-sol', true, false],
        ['xai.grok-4.6', false, false], ['xai.grok-4.7', true, false],
        ['openai.gpt-next', true, true], ['openai.gpt-oss-120b-1:0', false, false],
        ['openai.gpt-oss-safeguard-20b', false, false], ['nvidia.nemotron-nano-12b-v2', true, false],
        ['future.new-model', false, false],
    ])('applies independent company and family rules to %s', (id, visible, versionUnknown) => {
        const policy = parseModelVisibility({ mode: 'selected', providers: ['anthropic', 'openai', 'xai', 'nvidia'], minimumVersions: { claude: '4.6', gpt: '6', grok: '4.7' } }).value;
        expect(modelVisibility(id as string, policy)).toEqual({ visible, versionUnknown });
    });
    it('does not mark unknown versions without a threshold or bypass an unselected provider', () => {
        expect(modelVisibility('openai.gpt-next', parseModelVisibility(selected(['openai'])).value)).toEqual({ visible: true, versionUnknown: false });
        expect(modelVisibility('openai.gpt-next', parseModelVisibility({ ...selected(['nvidia']), minimumVersions: { gpt: '6' } }).value)).toEqual({ visible: false, versionUnknown: false });
    });
    /** User decision 2026-10-25: a GPT minimum hides the GPT-OSS series; without it they follow the OpenAI selection. */
    it('hides GPT-OSS only while a GPT minimum is set', () => {
        const without = parseModelVisibility(selected(['openai'])).value;
        const withMinimum = parseModelVisibility({ ...selected(['openai']), minimumVersions: { gpt: '6' } }).value;
        const claudeOnly = parseModelVisibility({ ...selected(['openai']), minimumVersions: { claude: '4.6' } }).value;
        for (const id of ['openai.gpt-oss-120b-1:0', 'openai.gpt-oss-safeguard-20b']) {
            expect(modelVisibility(id, without).visible).toBe(true);
            expect(modelVisibility(id, claudeOnly).visible).toBe(true);
            expect(modelVisibility(id, withMinimum).visible).toBe(false);
        }
    });
    it('keeps future providers and aliases under all/other without parsing their parameters', () => {
        expect(modelVisibility('future.new-120b', parseModelVisibility({ mode: 'all', providers: [] }).value).visible).toBe(true);
        expect(modelVisibility('future.new-120b', parseModelVisibility(selected(['other'])).value).visible).toBe(true);
        expect(modelVisibility('moonshotai.kimi-k3', parseModelVisibility(selected(['moonshot'])).value).visible).toBe(true);
    });
    it('normalizes cache identity by provider order and equivalent trailing-zero versions', () => {
        expect(visibilityCacheKey(parseModelVisibility({ ...selected(['xai', 'openai']), minimumVersions: { gpt: '6.0' } }).value))
            .toBe(visibilityCacheKey(parseModelVisibility({ ...selected(['openai', 'xai']), minimumVersions: { gpt: '6' } }).value));
    });
});

/** Expected values come from the confirmed default (Anthropic and OpenAI, no minimum; user decision 2026-10-25), empty selection policy and the documented configuration contract. */
describe('visibility configuration', () => {
    it('defaults to Anthropic and OpenAI with no minimum when nothing is set', () => {
        expect(readModelVisibility(config)).toEqual({ value: selected(['anthropic', 'openai']), diagnostics: [] });
    });
    it('ignores the removed modelFilter setting even if an old settings file still contains it', () => {
        vi.mocked(config.get).mockImplementation(((key: string) => key === 'modelFilter' ? 'all' : undefined) as never);
        expect(readModelVisibility(config).value).toEqual(selected(['anthropic', 'openai']));
    });
    it('ignores manifest defaults when an explicit value exists', () => {
        visibility = { defaultValue: selected(['anthropic', 'openai']), globalValue: selected(['nvidia']) };
        expect(readModelVisibility(config).value).toEqual(selected(['nvidia']));
    });
    it('uses the complete highest scope without inheriting lower-scope thresholds', () => {
        visibility = { globalValue: { ...selected(['anthropic']), minimumVersions: { claude: '4.6' } }, workspaceValue: selected(['nvidia']) };
        expect(readModelVisibility(config).value).toEqual(selected(['nvidia']));
    });
    it('does not interpret explicit null as missing or fall back to the default', () => {
        visibility = { globalValue: selected(['anthropic']), workspaceValue: null };
        const result = readModelVisibility(config);
        expect(result.value).toEqual(selected([]));
        expect(result.diagnostics).not.toHaveLength(0);
    });
    it('distinguishes all from an explicit empty selection and permits omitted thresholds', () => {
        expect(parseModelVisibility({ mode: 'selected', providers: [] })).toEqual({ value: selected([]), diagnostics: [] });
        expect(parseModelVisibility({ mode: 'all', providers: ['nvidia'] }).value).toEqual({ mode: 'all', providers: [], minimumVersions: {} });
    });
    it.each([
        null, [], 'all', {}, { mode: 'selected' }, { mode: 'invalid', providers: [] },
        { ...selected(), providers: ['future'] }, { ...selected(), providers: ['anthropic', 'anthropic'] },
        { ...selected(), providers: [null] }, { ...selected(), extra: true },
        { ...selected(), minimumVersions: [] }, { ...selected(), minimumVersions: { llama: '4' } },
        { ...selected(), minimumVersions: { gpt: '' } }, { ...selected(), minimumVersions: { gpt: 6 } },
        { ...selected(), minimumVersions: { gpt: '6-beta' } },
    ])('diagnoses invalid JSON without widening the selection: %j', (raw) => {
        const result = parseModelVisibility(raw);
        expect(result.value).toEqual(selected([]));
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });
    it.each(['4.6', '6', '5.10', '6.0', '9007199254740991'])('accepts threshold syntax %s', (value) => {
        expect(isMinimumVersion(value)).toBe(true);
    });
    it.each(['', ' ', '0', '01', '-1', '6.', '.6', '6.01', '6-beta', 'NaN', '6\n', '6\r', '6\r\n', '9007199254740992', 6, null])('rejects invalid thresholds %s', (value) => {
        expect(isMinimumVersion(value)).toBe(false);
    });
    it('reads the same normalized visibility through readSettings', () => {
        visibility = { globalValue: selected(['nvidia']) };
        expect(readSettings()).toMatchObject({ modelVisibility: { value: selected(['nvidia']), diagnostics: [] } });
    });
});

/** UI expected values come from the same-setting, cancellation and no-overwrite requirements, not from AWS behavior. */
describe('visibility management menu', () => {
    it('saves one complete User setting and reads it back with thresholds', async () => {
        queueSelected();
        await pickModelVisibility(() => config, log);
        expect(update).toHaveBeenCalledExactlyOnceWith('modelVisibility', { mode: 'selected', providers: ['anthropic', 'openai', 'xai'], minimumVersions: { claude: '4.6', gpt: '6', grok: '4.7' } }, vscode.ConfigurationTarget.Global);
        expect(readModelVisibility(config).value.minimumVersions).toEqual({ claude: '4.6', gpt: '6', grok: '4.7' });
        expect(log.info).toHaveBeenCalledOnce();
    });
    /** User decision 2026-10-25: only selected families are asked, and omitted families' saved thresholds are removed on save. */
    it('removes the GPT threshold after deselecting OpenAI while keeping selected thresholds', async () => {
        visibility = { globalValue: { ...selected(['anthropic', 'openai', 'xai']), minimumVersions: { claude: '5.5', gpt: '6', grok: '4.5' } } };
        vi.mocked(vscode.window.showQuickPick)
            .mockResolvedValueOnce({ mode: 'selected', label: 'Selected providers' } as never)
            .mockResolvedValueOnce([{ key: 'anthropic' }, { key: 'xai' }] as never)
            .mockResolvedValueOnce({ save: true } as never);
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('5.5').mockResolvedValueOnce('4.5');
        await pickModelVisibility(() => config, log);
        const titles = vi.mocked(vscode.window.showInputBox).mock.calls.map(([options]) => options?.title);
        expect(titles).toHaveLength(2);
        expect(titles.join('|')).toContain('Claude');
        expect(titles.join('|')).toContain('Grok');
        expect(titles.join('|')).not.toContain('GPT');
        expect(update).toHaveBeenCalledExactlyOnceWith('modelVisibility', { mode: 'selected', providers: ['anthropic', 'xai'], minimumVersions: { claude: '5.5', grok: '4.5' } }, vscode.ConfigurationTarget.Global);
    });
    it('clears every saved threshold when selected mode has no providers', async () => {
        visibility = { globalValue: { ...selected(['anthropic', 'openai', 'xai']), minimumVersions: { claude: '5.5', gpt: '6', grok: '4.5' } } };
        vi.mocked(vscode.window.showQuickPick)
            .mockResolvedValueOnce({ mode: 'selected', label: 'Selected providers' } as never)
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce({ save: true } as never);
        await pickModelVisibility(() => config, log);
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledExactlyOnceWith('modelVisibility', { mode: 'selected', providers: [], minimumVersions: {} }, vscode.ConfigurationTarget.Global);
    });
    it('asks for every family in all mode', async () => {
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ mode: 'all', label: 'All providers' } as never).mockResolvedValueOnce({ save: true } as never);
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('');
        await pickModelVisibility(() => config, log);
        expect(vi.mocked(vscode.window.showInputBox)).toHaveBeenCalledTimes(3);
    });
    it('round-trips an explicit empty selection rather than all', async () => {
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ mode: 'selected', label: 'Selected providers' } as never).mockResolvedValueOnce([] as never).mockResolvedValueOnce({ save: true } as never);
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('');
        await pickModelVisibility(() => config, log);
        expect(readModelVisibility(config).value).toEqual(selected([]));
        expect(update).toHaveBeenCalledOnce();
    });
    it('saves all as an independent mode, not a snapshot of provider keys', async () => {
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ mode: 'all', label: 'All providers' } as never).mockResolvedValueOnce({ save: true } as never);
        vi.mocked(vscode.window.showInputBox).mockResolvedValue('');
        await pickModelVisibility(() => config, log);
        expect(readModelVisibility(config).value).toEqual({ mode: 'all', providers: [], minimumVersions: {} });
    });
    it('reads current JSON selections, family labels and thresholds into the menu', async () => {
        visibility = { globalValue: { ...selected(['nvidia', 'other']), minimumVersions: { gpt: '6' } } };
        queueSelected();
        await pickModelVisibility(() => config, log);
        const [modes] = vi.mocked(vscode.window.showQuickPick).mock.calls[0]!;
        expect(modes).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'selected', description: expect.stringContaining('current') })]));
        expect((modes as vscode.QuickPickItem[])[0]).toMatchObject({ mode: 'selected' });
        const [items, options] = vi.mocked(vscode.window.showQuickPick).mock.calls[1]!;
        expect(options).toMatchObject({ canPickMany: true, matchOnDescription: true });
        expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'nvidia', picked: true, description: 'Nemotron' }),
            expect.objectContaining({ key: 'openai', picked: false, description: 'GPT, GPT-OSS, GPT-OSS Safeguard' }),
            expect.objectContaining({ key: 'other', picked: true }),
        ]));
        expect(vi.mocked(vscode.window.showInputBox).mock.calls[1]![0]).toMatchObject({ value: '6' });
    });
    it.each(['mode', 'providers', 'claude', 'gpt', 'grok', 'confirmation'])('does not write when cancelling %s', async (stage) => {
        const quick = vi.mocked(vscode.window.showQuickPick);
        const input = vi.mocked(vscode.window.showInputBox);
        if (stage !== 'mode') quick.mockResolvedValueOnce({ mode: 'selected', label: 'Selected providers' } as never);
        if (!['mode', 'providers'].includes(stage)) quick.mockResolvedValueOnce([{ key: 'anthropic' }, { key: 'openai' }, { key: 'xai' }] as never);
        if (['gpt', 'grok', 'confirmation'].includes(stage)) input.mockResolvedValueOnce('4.6');
        if (['grok', 'confirmation'].includes(stage)) input.mockResolvedValueOnce('6');
        if (stage === 'confirmation') input.mockResolvedValueOnce('4.7');
        await pickModelVisibility(() => config, log);
        expect(update).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });
    it('validates input and rejects invalid data even if a UI substitute bypasses validation', async () => {
        queueSelected();
        vi.mocked(vscode.window.showInputBox).mockReset().mockResolvedValueOnce('bad').mockResolvedValueOnce('').mockResolvedValueOnce('');
        await pickModelVisibility(() => config, log);
        const options = vi.mocked(vscode.window.showInputBox).mock.calls[0]![0]!;
        expect(options.validateInput!('6')).toBeUndefined();
        expect(options.validateInput!('   ')).toBeUndefined();
        expect(options.validateInput!('bad')).toBeTruthy();
        expect(update).not.toHaveBeenCalled();
    });
    it('writes back the active workspace override instead of changing hidden User settings', async () => {
        visibility = { workspaceValue: selected(['nvidia']) };
        queueSelected();
        await pickModelVisibility(() => config, log);
        expect(update).toHaveBeenCalledWith('modelVisibility', expect.anything(), vscode.ConfigurationTarget.Workspace);
    });
    it('detects edits from a fresh configuration snapshot and leaves concurrent JSON untouched', async () => {
        queueSelected();
        vi.mocked(vscode.window.showQuickPick).mockReset().mockResolvedValueOnce({ mode: 'selected', label: 'Selected providers' } as never).mockResolvedValueOnce([] as never).mockImplementationOnce(async () => {
            visibility = { globalValue: selected(['nvidia']) };
            return { save: true } as never;
        });
        await pickModelVisibility(() => ({ ...config }), log);
        expect(update).not.toHaveBeenCalled();
        expect(readModelVisibility(config).value).toEqual(selected(['nvidia']));
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
    it('reports write failure with a repair entry point but no success', async () => {
        queueSelected();
        update.mockRejectedValueOnce(new Error('settings are read-only'));
        vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Open Settings (JSON)' as never);
        await pickModelVisibility(() => config, log);
        expect(log.info).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('settings are read-only'));
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsJson');
    });
    it('offers JSON repair for invalid workspace settings without overwriting them', async () => {
        visibility = { workspaceValue: null };
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Open Settings (JSON)' as never);
        await pickModelVisibility(() => config, log);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openWorkspaceSettingsFile');
        expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });
    it('opens JSON without saving', async () => {
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ mode: 'json' } as never);
        await pickModelVisibility(() => config, log);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsJson');
        expect(update).not.toHaveBeenCalled();
    });
});