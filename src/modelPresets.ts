import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ResolvedModel } from './models';
import { effortLabel } from './statusBar';
import { THINKING_EFFORTS, type ThinkingEffort } from './thinking';

export const MODEL_PRESETS_SETTING = 'modelPresets';
export const PRESET_ROUTES: readonly ResolvedModel['route'][] = ['Geo', 'Global', 'In-Region'];

/** A fixed model/route/effort combination. The display name is generated, never stored. */
export interface ModelPreset {
    /** Stable identity, kept when the effort changes. */
    readonly id: string;
    /** Foundation model ID (`ResolvedModel.baseId`), never an inference-profile ID or ARN. */
    readonly modelId: string;
    readonly route: ResolvedModel['route'];
    readonly effort: ThinkingEffort;
}
export interface PresetsResult {
    readonly value: readonly ModelPreset[];
    readonly diagnostics: readonly string[];
}

const FIELDS = ['id', 'modelId', 'route', 'effort'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Same prefix convention as extension.ts routeOf: `us.anthropic.…` is an inference-profile ID, not a foundation model ID.
const isFoundationModelId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9][a-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !/^[a-z]+\.[a-z]+\./.test(value);
const comboKey = (preset: Pick<ModelPreset, 'modelId' | 'route' | 'effort'>) => JSON.stringify([preset.modelId, preset.route, preset.effort]);

/** Generated name, for example `Luna-Medium (Geo)`; Geo and Global presets of the same model stay distinguishable. */
export function presetName(modelName: string, effort: ThinkingEffort, route: ModelPreset['route']): string {
    return `${modelName}-${effortLabel(effort)} (${route})`;
}

/**
 * Keeps valid items only. Items sharing an ID, or a model/route/effort combination, are all rejected so that
 * array order never decides which one wins. Rejections are reported in diagnostics and never rewrite the setting.
 */
export function parseModelPresets(raw: unknown): PresetsResult {
    if (!Array.isArray(raw)) {
        return { value: [], diagnostics: ['modelPresets must be an array'] };
    }
    const diagnostics: string[] = [];
    const shaped: ModelPreset[] = [];
    raw.forEach((item: unknown, index) => {
        if (!isRecord(item)) {
            diagnostics.push(`modelPresets[${index}] must be an object`);
            return;
        }
        const problems = [
            ...(Object.keys(item).some((key) => !FIELDS.includes(key)) ? ['unknown properties'] : []),
            ...(typeof item.id === 'string' && item.id !== '' && item.id.trim() === item.id ? [] : ['id must be a non-empty string without surrounding spaces']),
            ...(isFoundationModelId(item.modelId) ? [] : ['modelId must be a foundation model ID']),
            ...(PRESET_ROUTES.includes(item.route as ModelPreset['route']) ? [] : ['route must be Geo, Global or In-Region']),
            ...(THINKING_EFFORTS.includes(item.effort as ThinkingEffort) ? [] : ['effort is not a supported thinking effort']),
        ];
        if (problems.length > 0) {
            diagnostics.push(`modelPresets[${index}]: ${problems.join('; ')}`);
        } else {
            shaped.push({ id: item.id as string, modelId: item.modelId as string, route: item.route as ModelPreset['route'], effort: item.effort as ThinkingEffort });
        }
    });
    const duplicated = (keyOf: (preset: ModelPreset) => string) => {
        const counts = new Map<string, number>();
        for (const preset of shaped) counts.set(keyOf(preset), (counts.get(keyOf(preset)) ?? 0) + 1);
        return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
    };
    const duplicateIds = duplicated((preset) => preset.id);
    const duplicateCombos = duplicated(comboKey);
    if (duplicateIds.size > 0) diagnostics.push('modelPresets contains duplicate IDs; every item sharing an ID was rejected');
    if (duplicateCombos.size > 0) diagnostics.push('modelPresets contains duplicate model, route and effort combinations; every duplicate was rejected');
    return { value: shaped.filter((preset) => !duplicateIds.has(preset.id) && !duplicateCombos.has(comboKey(preset))), diagnostics };
}

/**
 * Uses the highest explicit scope as a complete array (a workspace array replaces the User array); a missing setting means no presets.
 * An explicit null or non-array value is invalid, not missing.
 */
export function readModelPresets(config: vscode.WorkspaceConfiguration): PresetsResult {
    const inspected = config.inspect<unknown>(MODEL_PRESETS_SETTING);
    for (const candidate of [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue]) {
        if (candidate !== undefined) {
            return parseModelPresets(candidate);
        }
    }
    return { value: [], diagnostics: [] };
}

type MenuItem = vscode.QuickPickItem & { action: 'add' | 'json' | 'preset'; preset?: ModelPreset };

/**
 * Create, change the effort of, or remove presets. Every stage can be cancelled without writing, and the array is
 * written to User settings once after confirmation. Invalid settings and workspace overrides are never edited here.
 */
export async function pickModelPresets(
    getConfig: () => vscode.WorkspaceConfiguration,
    getModels: () => readonly ResolvedModel[],
    log: Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'error'>,
    newId: () => string = randomUUID,
): Promise<void> {
    const snapshot = () => JSON.stringify(getConfig().inspect(MODEL_PRESETS_SETTING));
    const initialSnapshot = snapshot();
    const inspected = getConfig().inspect<unknown>(MODEL_PRESETS_SETTING);
    const overridden = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
    const openJson = vscode.l10n.t('Open Settings (JSON)');
    const openSettingsJson = () => vscode.commands.executeCommand(overridden ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson');
    const current = readModelPresets(getConfig());
    if (overridden || current.diagnostics.length > 0) {
        if (current.diagnostics.length > 0) {
            log.warn(current.diagnostics.join('; '));
        }
        const choice = await vscode.window.showWarningMessage(overridden
            ? vscode.l10n.t('Model presets are overridden by workspace settings. Edit them in the workspace settings JSON.')
            : vscode.l10n.t('The model presets setting is invalid. Fix it in Settings (JSON) before using this menu.'), openJson);
        if (choice === openJson) {
            await openSettingsJson();
        }
        return;
    }

    const models = getModels().filter((model) => model.thinking !== 'none');
    const baseOf = (preset: ModelPreset) => models.find((model) => model.baseId === preset.modelId && model.route === preset.route);
    const nameOf = (preset: ModelPreset) => presetName(baseOf(preset)?.name ?? preset.modelId, preset.effort, preset.route);
    const isDuplicate = (candidate: ModelPreset) => current.value.some((preset) => preset.id !== candidate.id && comboKey(preset) === comboKey(candidate));
    const pickEffort = async (modelName: string, now?: ThinkingEffort) => (await vscode.window.showQuickPick(
        THINKING_EFFORTS.map((effort) => ({ label: effortLabel(effort), description: effort === now ? vscode.l10n.t('current') : undefined, effort })),
        { title: vscode.l10n.t('Thinking effort for {0}', modelName) },
    ))?.effort;

    const commit = async (next: readonly ModelPreset[], confirmName?: string): Promise<void> => {
        if (confirmName !== undefined) {
            const save = vscode.l10n.t('Save');
            const confirmation = await vscode.window.showQuickPick([{ label: save, save: true }], {
                title: vscode.l10n.t('Save model preset'),
                placeHolder: vscode.l10n.t('Preset name: {0}', confirmName),
            });
            if (!confirmation?.save) {
                return;
            }
        }
        if (snapshot() !== initialSnapshot) {
            log.warn('Model preset settings changed during editing; no settings were written');
            await vscode.window.showWarningMessage(vscode.l10n.t('Model preset settings changed while this menu was open. Open the menu again; nothing was saved.'));
            return;
        }
        try {
            await getConfig().update(MODEL_PRESETS_SETTING, [...next], vscode.ConfigurationTarget.Global);
            log.info('Model presets saved');
        } catch (error) {
            log.error(`Could not save model presets: ${error instanceof Error ? error.message : String(error)}`);
            const choice = await vscode.window.showErrorMessage(vscode.l10n.t('Could not save model presets. Check Settings (JSON) and try again.'), openJson);
            if (choice === openJson) {
                await openSettingsJson();
            }
        }
    };
    const rejectDuplicate = async () => {
        await vscode.window.showWarningMessage(vscode.l10n.t('A preset with this model, route and thinking effort already exists. Nothing was saved.'));
    };

    const picked = await vscode.window.showQuickPick<MenuItem>([
        ...current.value.map((preset): MenuItem => ({
            label: nameOf(preset),
            description: baseOf(preset) ? preset.modelId : `${preset.modelId} · ${vscode.l10n.t('Unavailable with the current profile, route or model filter')}`,
            action: 'preset',
            preset,
        })),
        { label: vscode.l10n.t('Add preset'), action: 'add' },
        { label: openJson, action: 'json' },
    ], { title: vscode.l10n.t('Manage model presets'), placeHolder: vscode.l10n.t('Choose a preset to change or remove, or add a new one') });
    if (!picked) {
        return;
    }
    if (picked.action === 'json') {
        await openSettingsJson();
        return;
    }
    if (picked.action === 'add') {
        if (models.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No models with configurable thinking effort are available. Open the Chat model picker once so the model list is loaded.'));
            return;
        }
        const base = await vscode.window.showQuickPick(
            models.map((model) => ({ label: model.name, description: `${model.route} · ${model.baseId}`, model })),
            { title: vscode.l10n.t('Add model preset'), placeHolder: vscode.l10n.t('Choose a base model'), matchOnDescription: true },
        );
        if (!base) {
            return;
        }
        const effort = await pickEffort(base.model.name);
        if (!effort) {
            return;
        }
        const added: ModelPreset = { id: newId(), modelId: base.model.baseId, route: base.model.route, effort };
        if (isDuplicate(added)) {
            await rejectDuplicate();
            return;
        }
        await commit([...current.value, added], presetName(base.model.name, effort, added.route));
        return;
    }

    const preset = picked.preset;
    if (!preset) {
        return;
    }
    const action = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('Change thinking effort'), remove: false },
        { label: vscode.l10n.t('Remove preset'), remove: true },
    ], { title: nameOf(preset) });
    if (!action) {
        return;
    }
    if (action.remove) {
        const remove = vscode.l10n.t('Remove');
        const confirmation = await vscode.window.showWarningMessage(
            vscode.l10n.t('Remove model preset "{0}"? The base model and past usage are not changed.', nameOf(preset)),
            { modal: true },
            remove,
        );
        if (confirmation === remove) {
            await commit(current.value.filter((item) => item.id !== preset.id));
        }
        return;
    }
    const effort = await pickEffort(baseOf(preset)?.name ?? preset.modelId, preset.effort);
    if (!effort || effort === preset.effort) {
        return;
    }
    const changed: ModelPreset = { ...preset, effort };
    if (isDuplicate(changed)) {
        await rejectDuplicate();
        return;
    }
    await commit(current.value.map((item) => item.id === preset.id ? changed : item), nameOf(changed));
}
