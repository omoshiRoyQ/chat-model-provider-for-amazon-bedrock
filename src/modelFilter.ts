import * as vscode from 'vscode';

export const MODEL_VISIBILITY_SETTING = 'modelVisibility';

/** Namespaces/families observed in models.ts and models.test.ts; these labels do not imply availability. */
export const MODEL_PROVIDERS = [
    { key: 'amazon', label: 'Amazon', families: 'Nova' },
    { key: 'anthropic', label: 'Anthropic', families: 'Claude' },
    { key: 'cohere', label: 'Cohere', families: 'Embed, Rerank' },
    { key: 'deepseek', label: 'DeepSeek', families: 'DeepSeek' },
    { key: 'google', label: 'Google', families: 'Gemma' },
    { key: 'meta', label: 'Meta', families: 'Llama' },
    { key: 'minimax', label: 'MiniMax', families: 'MiniMax' },
    { key: 'mistral', label: 'Mistral AI', families: 'Mistral, Mixtral, Magistral, Ministral, Devstral, Pixtral, Voxtral' },
    { key: 'moonshot', label: 'Moonshot AI', families: 'Kimi' },
    { key: 'nvidia', label: 'NVIDIA', families: 'Nemotron' },
    { key: 'openai', label: 'OpenAI', families: 'GPT, GPT-OSS, GPT-OSS Safeguard' },
    { key: 'qwen', label: 'Qwen', families: 'Qwen' },
    { key: 'twelvelabs', label: 'TwelveLabs', families: 'Pegasus' },
    { key: 'writer', label: 'Writer', families: 'Palmyra' },
    { key: 'xai', label: 'xAI', families: 'Grok' },
    { key: 'zai', label: 'Z.AI', families: 'GLM' },
] as const;

export type ModelProvider = typeof MODEL_PROVIDERS[number]['key'] | 'other';
export const VERSION_FAMILIES = ['claude', 'gpt', 'grok'] as const;
export type VersionFamily = typeof VERSION_FAMILIES[number];
/** The provider each version family belongs to; its threshold only matters while that provider is visible. */
export const VERSION_FAMILY_PROVIDERS: Readonly<Record<VersionFamily, ModelProvider>> = { claude: 'anthropic', gpt: 'openai', grok: 'xai' };
export interface ModelVisibility {
    readonly mode: 'all' | 'selected';
    readonly providers: readonly ModelProvider[];
    readonly minimumVersions: Readonly<Partial<Record<VersionFamily, string>>>;
}
export interface VisibilityResult {
    readonly value: ModelVisibility;
    readonly diagnostics: readonly string[];
}

/** Accepts foundation baseId, never a display name or an inference-profile ID. */
export function classifyModel(baseId: string): { provider: ModelProvider; family: VersionFamily | 'gptOss' | 'gptOssSafeguard' | 'other' } {
    const namespace = baseId.split('.')[0];
    const provider = namespace === 'moonshotai' ? 'moonshot'
        : MODEL_PROVIDERS.find(({ key }) => key === namespace)?.key ?? 'other';
    const family = baseId.startsWith('anthropic.claude-') ? 'claude'
        : baseId.startsWith('openai.gpt-oss-safeguard-') ? 'gptOssSafeguard'
            : baseId.startsWith('openai.gpt-oss-') ? 'gptOss'
                : baseId.startsWith('openai.gpt-') ? 'gpt'
                    : baseId.startsWith('xai.grok-') ? 'grok' : 'other';
    return { provider, family };
}

/** Threshold syntax only; model generation extraction/comparison belongs to the list integration. */
export function isMinimumVersion(value: unknown): value is string {
    return typeof value === 'string' && /^[1-9]\d*(?:\.(?:0|[1-9]\d*))*(?![\s\S])/.test(value)
        && value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

/** Formats observed in CATALOG/PROBED_CAPABILITIES (AWS cards and Converse probes cited in models.ts).
 * Claude's dates and v1 revisions are suffixes, not generation components. Unverified variants/suffixes remain unknown.
 */
export function modelVersion(baseId: string): readonly number[] | undefined {
    let version: string | undefined;
    if (/^anthropic\.claude-3-(?:haiku|sonnet)-\d{8}-v1:0(?![\s\S])/.test(baseId)) {
        version = '3';
    } else if (baseId.startsWith('anthropic.claude-')) {
        const match = /^anthropic\.claude-(?:haiku|sonnet|opus|fable)-([1-9])(?:-([0-9]))?(?:-\d{8}-v1:0|-v1)?(?![\s\S])/.exec(baseId);
        if (match) version = match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
    } else if (baseId.startsWith('openai.gpt-')) {
        version = /^openai\.gpt-([1-9]\d*(?:\.(?:0|[1-9]\d*))?)(?:-(?:luna|sol|terra|astra))?(?![\s\S])/.exec(baseId)?.[1];
    } else if (baseId.startsWith('xai.grok-')) {
        version = /^xai\.grok-([1-9]\d*\.(?:0|[1-9]\d*))(?![\s\S])/.exec(baseId)?.[1];
    }
    return isMinimumVersion(version) ? version.split('.').map(Number) : undefined;
}

/** User rule: compare integer sequences, with omitted trailing components equivalent to zero. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const left = a[index] ?? 0;
        const right = b[index] ?? 0;
        if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
}

export function modelVisibility(baseId: string, visibility: ModelVisibility): { visible: boolean; versionUnknown: boolean } {
    const { provider, family } = classifyModel(baseId);
    if (visibility.mode !== 'all' && !visibility.providers.includes(provider)) {
        return { visible: false, versionUnknown: false };
    }
    // User decision (2026-10-25): once a GPT minimum is set, the GPT-OSS series is not listed.
    if (visibility.minimumVersions.gpt !== undefined && (family === 'gptOss' || family === 'gptOssSafeguard')) {
        return { visible: false, versionUnknown: false };
    }
    const minimum = VERSION_FAMILIES.includes(family as VersionFamily) ? visibility.minimumVersions[family as VersionFamily] : undefined;
    if (minimum === undefined) return { visible: true, versionUnknown: false };
    const version = modelVersion(baseId);
    return { visible: version === undefined || compareVersions(version, minimum.split('.').map(Number)) >= 0, versionUnknown: version === undefined };
}

/** Order-independent cache identity; settings parsing has already validated all values. */
export function visibilityCacheKey(visibility: ModelVisibility): string {
    return JSON.stringify([visibility.mode, [...visibility.providers].sort(), VERSION_FAMILIES.map((family) => {
        const version = visibility.minimumVersions[family]?.split('.').map(Number);
        while (version && version.length > 1 && version.at(-1) === 0) version.pop();
        return version ?? null;
    })]);
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyVisibility = (): ModelVisibility => ({ mode: 'selected', providers: [], minimumVersions: {} });

export function parseModelVisibility(raw: unknown): VisibilityResult {
    const diagnostics: string[] = [];
    if (!isRecord(raw)) {
        return { value: emptyVisibility(), diagnostics: ['modelVisibility must be an object'] };
    }
    if (Object.keys(raw).some((key) => !['mode', 'providers', 'minimumVersions'].includes(key))) {
        diagnostics.push('modelVisibility contains unknown properties');
    }
    if (raw.mode !== 'all' && raw.mode !== 'selected') {
        diagnostics.push('modelVisibility.mode must be all or selected');
    }
    const providers: ModelProvider[] = [];
    if (!Array.isArray(raw.providers)) {
        diagnostics.push('modelVisibility.providers must be an array');
    } else {
        for (const key of raw.providers) {
            if (key !== 'other' && !MODEL_PROVIDERS.some((provider) => provider.key === key)) {
                diagnostics.push('modelVisibility.providers contains an unknown provider');
            } else if (providers.includes(key as ModelProvider)) {
                diagnostics.push('modelVisibility.providers contains a duplicate provider');
            } else {
                providers.push(key as ModelProvider);
            }
        }
    }
    const minimumVersions: Partial<Record<VersionFamily, string>> = {};
    if (raw.minimumVersions !== undefined) {
        if (!isRecord(raw.minimumVersions)) {
            diagnostics.push('modelVisibility.minimumVersions must be an object');
        } else {
            for (const [family, version] of Object.entries(raw.minimumVersions)) {
                if (!VERSION_FAMILIES.includes(family as VersionFamily) || !isMinimumVersion(version)) {
                    diagnostics.push('modelVisibility.minimumVersions contains an unknown family or invalid version');
                } else {
                    minimumVersions[family as VersionFamily] = version;
                }
            }
        }
    }
    return diagnostics.length > 0 ? { value: emptyVisibility(), diagnostics } : {
        value: { mode: raw.mode as ModelVisibility['mode'], providers: raw.mode === 'all' ? [] : providers.sort(), minimumVersions },
        diagnostics,
    };
}

/** Use whole inspect scopes, not get's merged object. VS Code may merge local/Remote User within globalValue. */
export function readModelVisibility(config: vscode.WorkspaceConfiguration): VisibilityResult {
    const inspected = config.inspect<unknown>(MODEL_VISIBILITY_SETTING);
    // null is an explicit invalid value, not a missing setting.
    for (const candidate of [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue]) {
        if (candidate !== undefined) {
            return parseModelVisibility(candidate);
        }
    }
    // User decision (2026-10-25): the old modelFilter setting is removed; without an explicit value, Anthropic and OpenAI with no minimum.
    return { value: { mode: 'selected', providers: ['anthropic', 'openai'], minimumVersions: {} }, diagnostics: [] };
}

/** One configuration write after all stages, using the active workspace scope or otherwise User settings. */
export async function pickModelVisibility(getConfig: () => vscode.WorkspaceConfiguration, log: Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'error'>): Promise<void> {
    const config = getConfig();
    const snapshot = () => JSON.stringify(getConfig().inspect(MODEL_VISIBILITY_SETTING));
    const openSettingsJson = () => vscode.commands.executeCommand(config.inspect(MODEL_VISIBILITY_SETTING)?.workspaceValue !== undefined
        ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson');
    const initialSnapshot = snapshot();
    const current = readModelVisibility(config);
    const openJson = vscode.l10n.t('Open Settings (JSON)');
    if (current.diagnostics.length > 0) {
        log.warn(current.diagnostics.join('; '));
        const choice = await vscode.window.showWarningMessage(vscode.l10n.t('The model visibility setting is invalid. Fix it in Settings (JSON) before using this menu.'), openJson);
        if (choice === openJson) {
            await openSettingsJson();
        }
        return;
    }
    const modes = [
        { label: vscode.l10n.t('All providers'), description: vscode.l10n.t('Includes future providers'), mode: 'all' as const },
        { label: vscode.l10n.t('Selected providers'), description: vscode.l10n.t('An empty selection shows no models'), mode: 'selected' as const },
    ].sort((a, b) => Number(b.mode === current.value.mode) - Number(a.mode === current.value.mode));
    const mode = await vscode.window.showQuickPick([
        ...modes.map((item) => ({ ...item, description: item.mode === current.value.mode ? `${vscode.l10n.t('current')} · ${item.description}` : item.description })),
        { label: openJson, mode: 'json' as const, description: undefined },
    ], { title: vscode.l10n.t('Configure model visibility'), placeHolder: vscode.l10n.t('Choose all providers or select providers') });
    if (!mode) {
        return;
    }
    if (mode.mode === 'json') {
        await openSettingsJson();
        return;
    }
    let providers: ModelProvider[] = [];
    if (mode.mode === 'selected') {
        const selected = await vscode.window.showQuickPick([
            ...MODEL_PROVIDERS.map(({ key, label, families }) => ({ key, label, description: families, picked: current.value.mode === 'all' || current.value.providers.includes(key) })),
            { key: 'other' as const, label: vscode.l10n.t('Other providers'), description: vscode.l10n.t('Unrecognized model namespaces'), picked: current.value.mode === 'all' || current.value.providers.includes('other') },
        ], { canPickMany: true, title: vscode.l10n.t('Select model providers'), placeHolder: vscode.l10n.t('Select providers; no selection means no models'), matchOnDescription: true });
        if (selected === undefined) {
            return;
        }
        providers = selected.map(({ key }) => key);
    }
    const minimumVersions: Partial<Record<VersionFamily, string>> = {};
    for (const family of VERSION_FAMILIES) {
        // Ask only about selected families; unselected thresholds are omitted so saving removes stale filters.
        if (mode.mode === 'selected' && !providers.includes(VERSION_FAMILY_PROVIDERS[family])) {
            continue;
        }
        const version = await vscode.window.showInputBox({
            title: vscode.l10n.t('Minimum version for {0}', family === 'claude' ? 'Claude' : family === 'gpt' ? 'GPT' : 'Grok'),
            prompt: vscode.l10n.t('Leave empty for no minimum. Unknown model versions remain visible. A GPT minimum also hides GPT-OSS and Safeguard.'),
            value: current.value.minimumVersions[family] ?? '',
            validateInput: (value) => value.trim() === '' || isMinimumVersion(value.trim()) ? undefined : vscode.l10n.t('Enter a version such as 4.6 or 6, or leave empty.'),
        });
        if (version === undefined) {
            return;
        }
        if (version.trim() !== '') {
            minimumVersions[family] = version.trim();
        }
    }
    const parsed = parseModelVisibility({ mode: mode.mode, providers, minimumVersions });
    if (parsed.diagnostics.length > 0) {
        log.warn(parsed.diagnostics.join('; '));
        return;
    }
    const save = vscode.l10n.t('Save');
    const confirmation = await vscode.window.showQuickPick([{ label: save, save: true }], {
        title: vscode.l10n.t('Save model visibility'),
        placeHolder: vscode.l10n.t('Mode: {0}; providers: {1}; minimum versions: {2}', mode.label, providers.join(', ') || '—', JSON.stringify(minimumVersions)),
    });
    if (!confirmation?.save) {
        return;
    }
    if (snapshot() !== initialSnapshot) {
        log.warn('Model visibility settings changed during editing; no settings were written');
        await vscode.window.showWarningMessage(vscode.l10n.t('Model visibility settings changed while this menu was open. Open the menu again; nothing was saved.'));
        return;
    }
    const latest = getConfig();
    const inspected = latest.inspect(MODEL_VISIBILITY_SETTING);
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
        await latest.update(MODEL_VISIBILITY_SETTING, parsed.value, target);
        log.info('Model visibility settings saved');
    } catch (error) {
        log.error(`Could not save model visibility: ${error instanceof Error ? error.message : String(error)}`);
        const choice = await vscode.window.showErrorMessage(vscode.l10n.t('Could not save model visibility settings. Check Settings (JSON) and try again.'), openJson);
        if (choice === openJson) {
            await openSettingsJson();
        }
    }
}