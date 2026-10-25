import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parseModelPresets, pickModelPresets, presetName, readModelPresets, type ModelPreset } from '../src/modelPresets';
import type { ResolvedModel } from '../src/models';

/**
 * Expected values come from the user's confirmed preset contract (2026-10-24): generated names such as `Luna-Medium (Geo)`,
 * a stored route, rejection of duplicate IDs and model/route/effort combinations, a Workspace array replacing the User array,
 * and User-only UI writes. They are not derived from AWS behavior.
 */
type Scope = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown };
let scopes: Scope;
let config: vscode.WorkspaceConfiguration;
let update: ReturnType<typeof vi.fn>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const preset = (id: string, modelId = 'openai.gpt-6-luna', route: ModelPreset['route'] = 'Geo', effort: ModelPreset['effort'] = 'medium'): ModelPreset => ({ id, modelId, route, effort });
const model = (baseId: string, name: string, route: ResolvedModel['route'], thinking: ResolvedModel['thinking'] = 'openaiNoNone'): ResolvedModel => ({
    invokeId: route === 'Geo' ? `us.${baseId}` : route === 'Global' ? `global.${baseId}` : baseId,
    baseId, name, route, thinking, contextWindow: 1_000, maxOutputTokens: 100, maxOutputSourced: true, imageInput: false, promptCache: false,
});
const luna = (route: ResolvedModel['route']) => model('openai.gpt-6-luna', 'Luna', route);
const models = [luna('Geo'), luna('Global'), model('openai.gpt-6-sol', 'Sol', 'In-Region'), model('amazon.nova-lite-v1:0', 'Nova Lite', 'Geo', 'none')];
const quick = () => vi.mocked(vscode.window.showQuickPick);
const queue = (...answers: unknown[]) => answers.forEach((answer) => quick().mockResolvedValueOnce(answer as never));
const manage = (available: readonly ResolvedModel[] = models, newId = () => 'new-id') => pickModelPresets(() => config, () => available, log, newId);
const written = () => update.mock.calls.map(([, value]) => value);

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    scopes = {};
    update = vi.fn(async (_key: string, value: unknown, target: vscode.ConfigurationTarget) => {
        scopes = target === vscode.ConfigurationTarget.Workspace ? { workspaceValue: value } : { globalValue: value };
    });
    config = {
        get: vi.fn(),
        inspect: vi.fn((key: string) => ({ key, ...scopes })),
        update,
        has: vi.fn(),
    } as unknown as vscode.WorkspaceConfiguration;
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue(config);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});

describe('generated preset names', () => {
    it.each([
        ['Luna', 'medium', 'Geo', 'Luna-Medium (Geo)'],
        ['Luna', 'max', 'Global', 'Luna-Max (Global)'],
        ['Luna', 'xhigh', 'In-Region', 'Luna-Extra High (In-Region)'],
        ['Luna', 'default', 'Geo', 'Luna-Default (Geo)'],
    ] as const)('names %s with %s on %s as %s', (name, effort, route, expected) => {
        expect(presetName(name, effort, route)).toBe(expected);
    });
    it('keeps Geo and Global presets of the same model and effort distinguishable', () => {
        expect(presetName('Luna', 'medium', 'Geo')).not.toBe(presetName('Luna', 'medium', 'Global'));
    });
});

describe('preset JSON parsing', () => {
    it.each([undefined, null, 'x', {}, 1])('treats a non-array value %j as invalid, never as presets', (raw) => {
        const result = parseModelPresets(raw);
        expect(result.value).toEqual([]);
        expect(result.diagnostics).not.toHaveLength(0);
    });
    it('accepts an empty array and every effort and route', () => {
        expect(parseModelPresets([])).toEqual({ value: [], diagnostics: [] });
        const efforts = ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
        const routes = ['Geo', 'Global', 'In-Region'] as const;
        const items = efforts.flatMap((effort) => routes.map((route) => preset(`${effort}-${route}`, 'openai.gpt-6-luna', route, effort)));
        expect(parseModelPresets(items)).toEqual({ value: items, diagnostics: [] });
    });
    it.each([
        ['null item', null], ['array item', []], ['string item', 'x'],
        ['missing id', { modelId: 'openai.gpt-6-luna', route: 'Geo', effort: 'low' }],
        ['empty id', { ...preset(''), id: '' }], ['padded id', { ...preset(' a') }], ['non-string id', { ...preset('a'), id: 1 }],
        ['missing modelId', { id: 'a', route: 'Geo', effort: 'low' }], ['empty modelId', preset('a', '')],
        ['Geo profile ID', preset('a', 'us.openai.gpt-6-luna')], ['Global profile ID', preset('a', 'global.openai.gpt-6-luna')],
        ['ARN', preset('a', 'arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.openai.gpt-6-luna')],
        ['no namespace', preset('a', 'luna')], ['trailing newline', preset('a', 'openai.gpt-6-luna\n')],
        ['unknown route', { ...preset('a'), route: 'geo' }], ['missing route', { id: 'a', modelId: 'openai.gpt-6-luna', effort: 'low' }],
        ['unknown effort', { ...preset('a'), effort: 'extreme' }], ['legacy name field', { ...preset('a'), name: 'Luna-meduim' }],
        ['unknown property', { ...preset('a'), endpoint: 'x' }],
    ])('rejects %s and keeps the valid item next to it', (_label, bad) => {
        const result = parseModelPresets([bad, preset('ok')]);
        expect(result.value).toEqual([preset('ok')]);
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });
    it('accepts foundation IDs with versions and revisions', () => {
        const ids = ['openai.gpt-6.1-sol', 'anthropic.claude-haiku-4-5-20251001-v1:0', 'openai.gpt-oss-120b-1:0'];
        expect(parseModelPresets(ids.map((id, index) => preset(String(index), id))).diagnostics).toEqual([]);
    });
    it('rejects every item sharing an ID instead of letting order decide', () => {
        const result = parseModelPresets([preset('abc'), preset('abc', 'openai.gpt-6-sol'), preset('def', 'openai.gpt-6-astra')]);
        expect(result.value).toEqual([preset('def', 'openai.gpt-6-astra')]);
        expect(result.diagnostics.join()).toContain('duplicate IDs');
    });
    it('rejects every item sharing model, route and effort, but treats Geo and Global or different efforts as distinct', () => {
        const dup = parseModelPresets([preset('a'), preset('b')]);
        expect(dup.value).toEqual([]);
        expect(dup.diagnostics.join()).toContain('duplicate model, route and effort');
        const distinct = [preset('a'), preset('b', 'openai.gpt-6-luna', 'Global'), preset('c', 'openai.gpt-6-luna', 'Geo', 'max'), preset('d', 'openai.gpt-6-sol')];
        expect(parseModelPresets(distinct)).toEqual({ value: distinct, diagnostics: [] });
    });
    it('does not mutate the raw setting', () => {
        const raw = [preset('a'), { ...preset('b'), name: 'x' }];
        const copy = JSON.parse(JSON.stringify(raw));
        parseModelPresets(raw);
        expect(raw).toEqual(copy);
    });
});

describe('preset settings scopes', () => {
    it('treats a missing setting as no presets', () => {
        expect(readModelPresets(config)).toEqual({ value: [], diagnostics: [] });
    });
    it('uses the complete highest explicit array without merging lower scopes', () => {
        scopes = { globalValue: [preset('u1'), preset('u2', 'openai.gpt-6-sol')], workspaceValue: [preset('w1')] };
        expect(readModelPresets(config).value).toEqual([preset('w1')]);
        scopes = { globalValue: [preset('u1')], workspaceValue: [preset('w1')], workspaceFolderValue: [preset('f1', 'openai.gpt-6-sol')] };
        expect(readModelPresets(config).value).toEqual([preset('f1', 'openai.gpt-6-sol')]);
    });
    it('keeps an explicit empty workspace array as no presets instead of inheriting User', () => {
        scopes = { globalValue: [preset('u1')], workspaceValue: [] };
        expect(readModelPresets(config)).toEqual({ value: [], diagnostics: [] });
    });
    it('does not treat an explicit null as missing', () => {
        scopes = { globalValue: [preset('u1')], workspaceValue: null };
        const result = readModelPresets(config);
        expect(result.value).toEqual([]);
        expect(result.diagnostics).not.toHaveLength(0);
    });
});

describe('preset management menu: add', () => {
    it('adds a generated-name preset with a fresh ID to User settings, after confirmation', async () => {
        queue({ action: 'add' }, { model: models[0] }, { effort: 'medium' }, { save: true });
        await manage();
        expect(written()).toEqual([[preset('new-id')]]);
        expect(update.mock.calls[0][2]).toBe(vscode.ConfigurationTarget.Global);
        expect(quick().mock.calls[3][1]).toMatchObject({ placeHolder: 'Preset name: Luna-Medium (Geo)' });
        expect(readModelPresets(config).value).toEqual([preset('new-id')]);
    });
    it('offers only models with configurable thinking, keeping each route as a separate base choice', async () => {
        queue({ action: 'add' });
        await manage();
        const menu = quick().mock.calls[0][0] as unknown as { action: string }[];
        expect(menu.map((item) => item.action)).toEqual(['add', 'json']);
        const choices = quick().mock.calls[1][0] as unknown as { label: string; description: string }[];
        expect(choices.map((c) => `${c.label} ${c.description}`)).toEqual([
            'Luna Geo · openai.gpt-6-luna', 'Luna Global · openai.gpt-6-luna', 'Sol In-Region · openai.gpt-6-sol',
        ]);
    });
    it('stores the route of the chosen row, so a Global preset differs from a Geo preset of the same model', async () => {
        scopes = { globalValue: [preset('a')] };
        queue({ action: 'add' }, { model: models[1] }, { effort: 'max' }, { save: true });
        await manage(models, () => 'g');
        expect(written()).toEqual([[preset('a'), preset('g', 'openai.gpt-6-luna', 'Global', 'max')]]);
    });
    it('rejects a duplicate model, route and effort without writing', async () => {
        scopes = { globalValue: [preset('a')] };
        queue({ action: 'add' }, { model: models[0] }, { effort: 'medium' });
        await manage();
        expect(update).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });
    it.each([
        ['the menu', []],
        ['base model selection', [{ action: 'add' }]],
        ['effort selection', [{ action: 'add' }, { model: models[0] }]],
        ['confirmation', [{ action: 'add' }, { model: models[0] }, { effort: 'low' }]],
        ['confirmation with a non-save answer', [{ action: 'add' }, { model: models[0] }, { effort: 'low' }, { save: false }]],
    ])('writes nothing when cancelled at %s', async (_stage, answers) => {
        queue(...answers);
        await manage();
        expect(update).not.toHaveBeenCalled();
    });
    it('explains why nothing can be added when no model supports thinking effort', async () => {
        queue({ action: 'add' });
        await manage([models[3]]);
        expect(update).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce();
    });
});

describe('preset management menu: change and remove', () => {
    it('lists presets by generated name and flags a preset whose route is not currently available, without deleting it', async () => {
        scopes = { globalValue: [preset('a'), preset('b', 'openai.gpt-6-sol', 'Geo', 'max')] };
        queue(undefined);
        await manage();
        const items = quick().mock.calls[0][0] as unknown as { label: string; description?: string }[];
        expect(items[0]).toMatchObject({ label: 'Luna-Medium (Geo)', description: 'openai.gpt-6-luna' });
        expect(items[1].label).toBe('openai.gpt-6-sol-Max (Geo)');
        expect(items[1].description).toContain('Unavailable');
        expect(update).not.toHaveBeenCalled();
    });
    it('changes only the effort and keeps the ID and route', async () => {
        scopes = { globalValue: [preset('a'), preset('b', 'openai.gpt-6-sol', 'In-Region', 'low')] };
        queue({ preset: preset('a') }, { remove: false }, { effort: 'max' }, { save: true });
        await manage();
        expect(written()).toEqual([[preset('a', 'openai.gpt-6-luna', 'Geo', 'max'), preset('b', 'openai.gpt-6-sol', 'In-Region', 'low')]]);
        expect(quick().mock.calls[3][1]).toMatchObject({ placeHolder: 'Preset name: Luna-Max (Geo)' });
    });
    it('does not write when the effort is unchanged or the change would duplicate another preset', async () => {
        scopes = { globalValue: [preset('a'), preset('b', 'openai.gpt-6-luna', 'Geo', 'max')] };
        queue({ preset: preset('a') }, { remove: false }, { effort: 'medium' });
        await manage();
        queue({ preset: preset('a') }, { remove: false }, { effort: 'max' });
        await manage();
        expect(update).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });
    it('removes only after a modal confirmation and leaves other presets', async () => {
        scopes = { globalValue: [preset('a'), preset('b', 'openai.gpt-6-sol')] };
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove' as never);
        queue({ preset: preset('a') }, { remove: true });
        await manage();
        expect(written()).toEqual([[preset('b', 'openai.gpt-6-sol')]]);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('"Luna-Medium (Geo)"'), { modal: true }, 'Remove');
    });
    it.each([
        ['the action menu', [{ preset: preset('a') }]],
        ['effort selection', [{ preset: preset('a') }, { remove: false }]],
        ['effort confirmation', [{ preset: preset('a') }, { remove: false }, { effort: 'max' }]],
    ])('writes nothing when cancelled at %s', async (_stage, answers) => {
        scopes = { globalValue: [preset('a')] };
        queue(...answers);
        await manage();
        expect(update).not.toHaveBeenCalled();
    });
    it('writes nothing when removal is declined', async () => {
        scopes = { globalValue: [preset('a')] };
        queue({ preset: preset('a') }, { remove: true });
        await manage();
        expect(update).not.toHaveBeenCalled();
    });
});

describe('preset management menu: safety', () => {
    it('refuses to edit invalid settings, keeps them untouched and offers the JSON editor', async () => {
        scopes = { globalValue: [preset('a'), { id: 'b' }] };
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Open Settings (JSON)' as never);
        await manage();
        expect(quick()).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsJson');
    });
    it('refuses to edit duplicate-ID settings so the rejected items are not silently dropped', async () => {
        scopes = { globalValue: [preset('a'), preset('a', 'openai.gpt-6-sol')] };
        await manage();
        expect(quick()).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });
    it('stops when a workspace array overrides User and opens the workspace JSON instead of writing User', async () => {
        scopes = { globalValue: [preset('u')], workspaceValue: [preset('w')] };
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Open Settings (JSON)' as never);
        await manage();
        expect(quick()).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openWorkspaceSettingsFile');
    });
    it('opens User JSON from the menu without writing', async () => {
        queue({ action: 'json' });
        await manage();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsJson');
        expect(update).not.toHaveBeenCalled();
    });
    it('refuses to overwrite settings edited while the menu was open', async () => {
        queue({ action: 'add' }, { model: models[0] }, { effort: 'low' });
        quick().mockImplementationOnce((async () => {
            scopes = { globalValue: [preset('other', 'openai.gpt-6-sol')] };
            return { save: true };
        }) as never);
        await manage();
        expect(update).not.toHaveBeenCalled();
        expect(scopes.globalValue).toEqual([preset('other', 'openai.gpt-6-sol')]);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('nothing was saved'));
    });
    it('reports a failed write without claiming success and offers the JSON editor', async () => {
        update.mockRejectedValueOnce(new Error('disk full'));
        vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Open Settings (JSON)' as never);
        queue({ action: 'add' }, { model: models[0] }, { effort: 'low' }, { save: true });
        await manage();
        expect(log.info).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsJson');
    });
    it('generates a standard UUID by default', async () => {
        queue({ action: 'add' }, { model: models[0] }, { effort: 'low' }, { save: true });
        await pickModelPresets(() => config, () => models, log);
        const [saved] = written()[0] as ModelPreset[];
        expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});
