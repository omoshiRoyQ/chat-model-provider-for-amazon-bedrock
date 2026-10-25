import * as vscode from 'vscode';
import { addCachePoints, buildToolConfig, toConverseMessages, toConverseSystem } from './convert';
import { describeError, describeErrorForLog, isCredentialError, isSystemMessageUnsupported } from './errors';
import { fetchModelSources } from './modelList';
import { modelVisibility, visibilityCacheKey } from './modelFilter';
import type { ModelCardStore } from './modelCardStore';
import { presetName, readModelPresets, type ModelPreset } from './modelPresets';
import { resolveModels, type ResolvedModel } from './models';
import { NativeConverseClient } from './native';
import { CONFIG_SECTION, readSettings, type BedrockSettings } from './settings';
import type { SsoSignIn } from './signIn';
import type { StreamPart, TokenUsage } from './native';
import type { SignInStatusBar } from './statusBar';
import { buildThinkingRequest, type ThinkingEffort } from './thinking';
import { ThinkingTagFilter } from './thinkingTags';

/** Interface between the provider and other extension components (token usage tracking and thinking settings). */
export interface ProviderHooks {
    /** Gets the thinking effort for a model. */
    thinkingEffort(modelId: string): ThinkingEffort;
    /** Called after a successful request reports token usage; profile is the one actually used for the request. */
    onUsage(profile: string, model: ResolvedModel | undefined, modelId: string, name: string, usage: TokenUsage): void;
}

/** Fallback label for model-list errors that cannot be attributed to a single AWS operation. */
const LIST_OPERATION = 'model list';

/** Chat model ID prefix for presets. Real Bedrock IDs never start with it, so a preset ID can never be sent to AWS by mistake. */
const PRESET_ID_PREFIX = 'bedrock-preset:';

/** A preset whose model and route are currently listed, resolved against its base model. */
interface ResolvedPreset {
    /** Chat model ID shown to VS Code (PRESET_ID_PREFIX + the stored preset ID). */
    readonly id: string;
    readonly name: string;
    readonly preset: ModelPreset;
    /** The underlying listed model; its invokeId, limits and capabilities are what the request uses. */
    readonly base: ResolvedModel;
}

interface ModelList {
    readonly models: ResolvedModel[];
    readonly presets: ResolvedPreset[];
}

function presetSettings() {
    return readModelPresets(vscode.workspace.getConfiguration(CONFIG_SECTION));
}

function listSettingsKey(settings: BedrockSettings): string {
    const presets = presetSettings();
    return JSON.stringify([settings.profile, settings.region, settings.inferenceScope, visibilityCacheKey(settings.modelVisibility.value), settings.modelVisibility.diagnostics, presets.value, presets.diagnostics]);
}

/**
 * Presets are matched against the already filtered list, so they inherit its provider/version filtering. A preset shows only when its model is
 * listed with exactly the stored route; a different route is never substituted, and models without configurable thinking are not offered.
 */
function expandPresets(presets: readonly ModelPreset[], models: readonly ResolvedModel[]): ResolvedPreset[] {
    const resolved: ResolvedPreset[] = [];
    for (const preset of presets) {
        const base = models.find((model) => model.baseId === preset.modelId && model.route === preset.route);
        if (base && base.thinking !== 'none') {
            resolved.push({ id: `${PRESET_ID_PREFIX}${preset.id}`, name: presetName(base.name, preset.effort, preset.route), preset, base });
        }
    }
    return resolved;
}

/**
 * Amazon Bedrock LanguageModelChatProvider.
 * Dynamically loads the model list through control-plane APIs and streams text and tool calls through Native Converse.
 */
export class AmazonBedrockProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
    private readonly native: NativeConverseClient;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly configListener: vscode.Disposable;
    private warnedMissingProfile = false;
    private lastModelListErrorKey: string | undefined;

    /**
    * Model-list cache. VS Code queries the list frequently, so fetch it only once for each settings combination;
    * clear it when settings change. Failed queries are not cached, so the next query retries (for example, after `aws sso login`).
    * Cache only which models are available, not whether they can be invoked; permissions can change at any time, so invocation results are authoritative.
     */
    private listCache: { key: string; promise: Promise<ModelList> } | undefined;
    /** Display-only changes reuse the existing control-plane source query. Failed queries are never cached. */
    private sourceCache: { key: string; promise: ReturnType<typeof fetchModelSources> } | undefined;
    private listGeneration = 0;
    private cardRefreshPending = false;
    private queuedCardIds: readonly string[] | undefined;
    private refreshingCardIds: readonly string[] = [];
    private cardsRelevant = false;
    private disposed = false;
    /** Models from the most recent successful query, indexed by the model ID seen by VS Code. */
    private modelsById = new Map<string, ResolvedModel>();
    /** Presets from the most recent successful query, indexed by their Chat model ID. */
    private presetsById = new Map<string, ResolvedPreset>();
    /** Region used by the most recent model-list query (from settings or resolved by the SDK from the profile). */
    private resolvedRegion = '';

    /** Models that rejected Converse system messages in this session; their system prompt is sent as user text. */
    private readonly noSystemModels = new Set<string>();

    /** Notifies VS Code to query the model list again when settings change. */
    readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

    /** Whether credentials are currently expired or invalid. */
    private credentialProblem = false;
    /** Whether a notification has already been shown during the current unauthenticated period. */
    private credentialNotified = false;

    constructor(
        private readonly log: vscode.LogOutputChannel,
        private readonly signInBar: SignInStatusBar,
        private readonly sso: SsoSignIn,
        private readonly hooks: ProviderHooks,
        private readonly modelCards: ModelCardStore,
    ) {
        this.native = new NativeConverseClient(log);
        this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                this.warnedMissingProfile = false;
                this.listCache = undefined;
                this.listGeneration++;
                this.cardsRelevant = false;
                const settings = readSettings();
                if (this.sourceCache?.key !== JSON.stringify([settings.profile, settings.region])) this.sourceCache = undefined;
                this.changeEmitter.fire();
            }
        });
    }

    /** Current region: prefer the configured value, otherwise use the most recently resolved profile region; empty before the first query. */
    get region(): string {
        return readSettings().region || this.resolvedRegion;
    }

    /** Models from the most recent query. */
    get models(): readonly ResolvedModel[] {
        return [...this.modelsById.values()];
    }

    dispose(): void {
        this.disposed = true;
        this.listGeneration++;
        this.configListener.dispose();
        this.changeEmitter.dispose();
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const settings = readSettings();
        if (!settings.profile) {
            this.modelsById.clear();
            this.presetsById.clear();
            this.resolvedRegion = '';
            this.cardsRelevant = false;
            // VS Code queries the model list frequently; log this state only once to avoid flooding the output.
            if (!this.warnedMissingProfile) {
                this.log.warn(`No AWS profile is configured at ${CONFIG_SECTION}.profile; no models will be returned`);
                this.warnedMissingProfile = true;
            }
            return [];
        }
        let queryGeneration = this.listGeneration;
        try {
            const query = this.listModels(settings);
            queryGeneration = this.listGeneration;
            const list = await query;
            if (queryGeneration !== this.listGeneration || this.disposed) return [];
            this.lastModelListErrorKey = undefined;
            return [...list.models.map((model) => toChatInformation(model)), ...list.presets.map(presetChatInformation)];
        } catch (error) {
            if (this.disposed || queryGeneration !== this.listGeneration || listSettingsKey(readSettings()) !== listSettingsKey(settings)) return [];
            const message = describeError(error, LIST_OPERATION, 'Native', settings.profile);
            const logMessage = describeErrorForLog(error, LIST_OPERATION, 'Native', settings.profile);
            if (isCredentialError(error)) {
                // VS Code queries frequently; log this only once during an unauthenticated period.
                if (!this.credentialProblem) {
                    this.log.error(logMessage);
                }
                // With silent=true, VS Code is querying in the background; do not show a notification, only the status-bar sign-in button.
                this.reportCredentialProblem(settings.profile, message, !options.silent);
            } else {
                this.log.error(logMessage);
                this.reportModelListError(error, settings.profile, settings.region, message);
            }
            return [];
        }
    }

    private reportModelListError(error: unknown, profile: string, region: string, message: string): void {
        const details = (error ?? {}) as { name?: string; message?: string; operation?: string; region?: string };
        const key = [profile, details.operation ?? LIST_OPERATION, details.region ?? region, details.name ?? 'Error', details.message ?? ''].join('|');
        if (this.lastModelListErrorKey === key) {
            return;
        }
        this.lastModelListErrorKey = key;
        const showLogs = vscode.l10n.t('Show Logs');
        void vscode.window.showErrorMessage(message, showLogs).then((choice) => {
            if (choice === showLogs) {
                this.log.show();
            }
        });
    }

    /**
    * Runs `aws sso login`, triggered by a user-selected button or command.
    * On success, clears the model-list cache and notifies VS Code to query again. Failed Chat requests are not retried automatically; the user resends them.
     */
    async signIn(): Promise<void> {
        const { profile } = readSettings();
        if (!profile) {
            void vscode.window.showWarningMessage(vscode.l10n.t('Set `{0}.profile` first.', CONFIG_SECTION));
            return;
        }
        const ok = await this.sso.run(profile);
        if (ok) {
            this.clearCredentialProblem();
            this.listCache = undefined;
            this.sourceCache = undefined;
            this.listGeneration++;
            this.changeEmitter.fire();
            void vscode.window.showInformationMessage(
                vscode.l10n.t('Signed in to AWS with profile "{0}". If a chat request failed, send it again.', profile),
            );
        } else {
            const showLogs = vscode.l10n.t('Show Logs');
            const choice = await vscode.window.showWarningMessage(vscode.l10n.t('AWS sign-in did not complete.'), showLogs);
            if (choice === showLogs) {
                this.log.show();
            }
        }
    }

    /**
    * Shows the sign-in button. Show a notification only once during each unauthenticated period to avoid flooding;
    * reset the state after sign-in or when queries recover. The caller is responsible for logging.
     */
    private reportCredentialProblem(profile: string, message: string, notify: boolean): void {
        if (!this.credentialProblem) {
            this.credentialProblem = true;
            this.signInBar.show(profile);
        }
        if (notify && !this.credentialNotified) {
            this.credentialNotified = true;
            const signIn = vscode.l10n.t('Sign in');
            void vscode.window.showErrorMessage(message, signIn).then((choice) => {
                if (choice === signIn) {
                    void this.signIn();
                }
            });
        }
    }

    private clearCredentialProblem(): void {
        if (this.credentialProblem) {
            this.log.info('AWS credentials restored');
        }
        this.credentialProblem = false;
        this.credentialNotified = false;
        this.signInBar.hide();
    }

    /** Reuses one query for each settings combination; VS Code often issues several queries concurrently. */
    private listModels(settings: BedrockSettings): Promise<ModelList> {
        const key = listSettingsKey(settings);
        if (this.listCache?.key === key) {
            return this.listCache.promise;
        }
        const generation = ++this.listGeneration;
        const current = () => !this.disposed && generation === this.listGeneration && listSettingsKey(readSettings()) === key;
        const promise = (async () => {
            this.log.info(`Loading model list: profile=${settings.profile}, scope=${settings.inferenceScope}, modelVisibility=${visibilityCacheKey(settings.modelVisibility.value)}`);
            for (const diagnostic of settings.modelVisibility.diagnostics) this.log.warn(diagnostic);
            const sources = await this.modelSources(settings);
            if (!current()) return { models: [], presets: [] };
            this.resolvedRegion = sources.region;
            this.log.info(`Resolved region=${sources.region} (${settings.region ? 'from settings' : 'from profile'})`);
            if (sources.foundationsDenied) {
                this.log.warn(`AWS profile "${settings.profile}" lacks bedrock:ListFoundationModels; listing inference profiles only and assuming image input is supported`);
            }
            const { models, notes, unknownIds, usesModelCards } = resolveModels(
                sources.profiles,
                sources.foundations,
                settings.inferenceScope,
                false,
                this.modelCards.limits(),
                undefined,
                (baseId) => modelVisibility(baseId, settings.modelVisibility.value).visible,
            );
            for (const note of notes) {
                this.log.info(note);
            }
            this.log.info(`Reported ${models.length} models (inference profiles=${sources.profiles.length}, foundation models=${sources.foundations.length}, imageInput=${models.filter((m) => m.imageInput).length})`);
            const visibleModels = models.map((model) => modelVisibility(model.baseId, settings.modelVisibility.value).versionUnknown
                ? { ...model, versionUnknown: true } : model);
            this.modelsById = new Map(visibleModels.map((m) => [m.invokeId, m]));
            const presetConfig = presetSettings();
            for (const diagnostic of presetConfig.diagnostics) this.log.warn(diagnostic);
            const presets = expandPresets(presetConfig.value, visibleModels);
            this.presetsById = new Map(presets.map((p) => [p.id, p]));
            if (presets.length < presetConfig.value.length) {
                this.log.info(`Hidden ${presetConfig.value.length - presets.length} of ${presetConfig.value.length} model presets: base model or route is not in the current list`);
            }
            this.cardsRelevant = unknownIds.length > 0 || usesModelCards;
            if ((unknownIds.length > 0 || usesModelCards) && this.modelCards.needsRefresh(unknownIds)) {
                this.refreshModelCards(unknownIds);
            }
            return { models: visibleModels, presets };
        })();
        this.listCache = { key, promise };
        promise.catch(() => {
            // Do not cache failed queries so the next query can retry.
            if (this.listCache?.promise === promise) {
                this.listCache = undefined;
            }
        });
        return promise;
    }

    private modelSources(settings: BedrockSettings): ReturnType<typeof fetchModelSources> {
        const key = JSON.stringify([settings.profile, settings.region]);
        if (this.sourceCache?.key === key) return this.sourceCache.promise;
        const promise = fetchModelSources(settings.profile, settings.region).then((sources) => {
            const latest = readSettings();
            // Only a real query proves credentials work; display-only recomposition must not hide the sign-in button.
            if (!this.disposed && this.sourceCache?.promise === promise && JSON.stringify([latest.profile, latest.region]) === key) this.clearCredentialProblem();
            return sources;
        });
        this.sourceCache = { key, promise };
        promise.catch(() => {
            if (this.sourceCache?.promise === promise) this.sourceCache = undefined;
        });
        return promise;
    }

    /** Runs in the background so the model list is not delayed; reloads the list when new card data arrives. */
    private refreshModelCards(unknownIds: readonly string[]): void {
        if (this.cardRefreshPending) {
            if (unknownIds.some((id) => !this.refreshingCardIds.includes(id))) this.queuedCardIds = unknownIds;
            return;
        }
        this.cardRefreshPending = true;
        this.refreshingCardIds = unknownIds;
        const previous = this.modelCards.limits();
        const cardKey = (limits: ReturnType<ModelCardStore['limits']>, id: string) => {
            const card = limits.get(id);
            return JSON.stringify(card ? [card.contextWindow, card.maxOutputTokens, card.converse, card.longContextThreshold] : null);
        };
        this.log.info(`Fetching AWS model cards (models without catalog or card data: ${unknownIds.join(', ') || 'none'})`);
        this.modelCards.refresh(unknownIds).then(
            ({ fetched, failed }) => {
                this.cardRefreshPending = false;
                if (this.disposed) return;
                this.log.info(`Model cards updated: fetched=${fetched}${failed.length > 0 ? `, failed=${failed.join(', ')}` : ''}`);
                const latest = this.modelCards.limits();
                if (this.cardsRelevant && this.models.some((model) => cardKey(previous, model.baseId) !== cardKey(latest, model.baseId))) {
                    this.listCache = undefined;
                    this.listGeneration++;
                    this.changeEmitter.fire();
                }
                const queued = this.queuedCardIds;
                this.queuedCardIds = undefined;
                // Recheck only new, still-visible requests; do not loop on the same failed/search-only result.
                const visibleQueued = queued?.filter((id) => this.models.some((model) => model.baseId === id));
                if (this.cardsRelevant && visibleQueued && visibleQueued.length > 0 && this.modelCards.needsRefresh(visibleQueued)) this.refreshModelCards(visibleQueued);
            },
            (error: unknown) => {
                this.cardRefreshPending = false;
                this.queuedCardIds = undefined;
                if (this.disposed) return;
                this.log.warn(`Could not fetch AWS model cards: ${error instanceof Error ? error.message : String(error)}; conservative limits remain in use`);
            },
        );
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const settings = readSettings();
        // Snapshot taken once: a preset removed or changed while this request runs does not alter it.
        const preset = this.presetsById.get(model.id);
        if (!preset && model.id.startsWith(PRESET_ID_PREFIX)) {
            const message = vscode.l10n.t('Model preset "{0}" is no longer available. Pick another model, or restore the preset in the model presets setting.', model.id.slice(PRESET_ID_PREFIX.length));
            this.log.error(`model=${model.id} rejected: preset is not in the current model list (path=Native)`);
            throw new Error(message);
        }
        // From here on, presets use the underlying model for everything sent to AWS and recorded as usage.
        const callId = preset?.base.invokeId ?? model.id;
        const callName = preset?.base.name ?? model.name;
        const resolved = preset?.base ?? this.modelsById.get(model.id);
        const imageInput = resolved?.imageInput ?? model.capabilities.imageInput ?? false;
        const systemAsUser = this.noSystemModels.has(callId);
        const system = systemAsUser ? undefined : toConverseSystem(messages);
        const converseMessages = toConverseMessages(messages, this.log, imageInput, systemAsUser);
        const toolConfig = buildToolConfig(options.tools, options.toolMode, converseMessages);
        // A preset's effort is fixed and never read from the per-model store.
        const effort = preset ? preset.preset.effort : this.hooks.thinkingEffort(model.id);
        const thinking = buildThinkingRequest(
            resolved?.thinking ?? 'none',
            effort,
            resolved?.maxOutputTokens ?? model.maxOutputTokens,
            toolConfig?.toolChoice?.any !== undefined,
        );
        if (!resolved) {
            this.log.warn(`model=${model.id} is not in the latest model list; thinking parameters omitted`);
        }
        if (thinking.note) {
            this.log.info(`model=${callId} thinking: ${thinking.note}`);
        }
        const images = converseMessages.reduce((n, m) => n + (m.content?.filter((b) => b.image).length ?? 0), 0);
        // Raw VS Code roles (1=user, 2=assistant; other values are not in the stable API) before merging.
        const roles = [...messages.reduce((m, x) => m.set(x.role, (m.get(x.role) ?? 0) + 1), new Map<number, number>())].map(([r, n]) => `${r}:${n}`).join(',');
        const promptCache = resolved?.promptCache ?? false;
        this.log.info(
            `Sending request: model=${callId}${preset ? `, preset=${preset.preset.id}` : ''}, path=Native, messages=${converseMessages.length}, roles=${roles}, system=${system ? 'field' : systemAsUser ? 'as-user' : 'none'}, images=${images}, tools=${options.tools?.length ?? 0}, toolConfig=${toolConfig ? toolConfig.tools?.length : 'none'}, thinkingEffort=${effort}, fields=${thinking.fields ? JSON.stringify(thinking.fields) : 'none'}, promptCache=${promptCache}`,
        );
        const withCache = <T extends Parameters<typeof addCachePoints>[0]>(r: T): T => (promptCache ? addCachePoints(r) : r);
        const baseRequest = {
            profile: settings.profile,
            region: settings.region,
            modelId: callId,
            messages: converseMessages,
            system,
            toolConfig,
            additionalFields: thinking.fields,
            // Without inferenceConfig, Bedrock applies the model's default cap (4,096 observed for Claude Haiku 5.5).
            maxTokens: thinking.maxTokens ?? (resolved?.maxOutputSourced ? resolved.maxOutputTokens : undefined),
        };
        const request = withCache(baseRequest);
        const tagFilter = callId.includes('amazon.nova-') ? new ThinkingTagFilter() : undefined;
        const reportText = (text: string) => {
            if (text) {
                progress.report(new vscode.LanguageModelTextPart(text));
            }
        };
        const onPart = (part: StreamPart) => {
            if (part.kind === 'text') {
                reportText(tagFilter ? tagFilter.push(part.text) : part.text);
            } else {
                reportText(tagFilter?.flush() ?? '');
                this.log.info(`model=${callId} called tool: ${part.name} (callId=${part.callId})`);
                progress.report(new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input));
            }
        };
        try {
            let usage;
            try {
                usage = await this.native.stream(request, onPart, token);
            } catch (error) {
                if (!system || !isSystemMessageUnsupported(error)) {
                    throw error;
                }
                // Bedrock validates before generating, so nothing was streamed or billed; resend with the system prompt as user text.
                this.noSystemModels.add(callId);
                this.log.warn(`model=${callId} does not support system messages; resending with the system prompt as user text`);
                const merged = toConverseMessages(messages, this.log, imageInput, true);
                usage = await this.native.stream(withCache({ ...baseRequest, messages: merged, system: undefined }), onPart, token);
            }
            if (tagFilter) {
                reportText(tagFilter.flush());
                if (tagFilter.removed > 0) {
                    this.log.info(`model=${callId} removed ${tagFilter.removed} characters of <thinking> text`);
                }
            }
            this.clearCredentialProblem();
            if (usage) {
                this.hooks.onUsage(settings.profile, resolved, callId, callName, usage);
            }
        } catch (error) {
            if (token.isCancellationRequested) {
                this.log.info(`model=${callId} request cancelled by user`);
                return;
            }
            const message = describeError(error, callId, 'Native', settings.profile);
            this.log.error(describeErrorForLog(error, callId, 'Native', settings.profile));
            if (isCredentialError(error)) {
                // The user is actively using Chat, so show a notification with a sign-in button; do not retry the request automatically.
                this.reportCredentialProblem(settings.profile, message, true);
            }
            throw new Error(message);
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken,
    ): Promise<number> {
        // Rough estimate: about one token per four characters. Reconsider Bedrock's CountTokens API later.
        const length = typeof text === 'string' ? text.length : JSON.stringify(text.content).length;
        return Math.ceil(length / 4);
    }
}

function toChatInformation(model: ResolvedModel, id = model.invokeId, name = model.name, extraDetail?: string): vscode.LanguageModelChatInformation {
    const unknown = model.versionUnknown ? vscode.l10n.t('Version unknown; retained despite the minimum version setting') : undefined;
    return {
        id,
        name,
        family: model.baseId,
        version: model.baseId,
        // VS Code's maxInputTokens is the input limit; subtract the output allowance from the context window.
        maxInputTokens: model.contextWindow - model.maxOutputTokens,
        maxOutputTokens: model.maxOutputTokens,
        detail: `Native · ${model.route}${extraDetail ? ` · ${extraDetail}` : ''}${unknown ? ` · ${unknown}` : ''}`,
        tooltip: `${model.invokeId}${unknown ? `\n${unknown}` : ''}`,
        // Current VS Code Agent, Ask, and Plan modes list only models with toolCalling=true
        // (see isModelSupportedForMode in microsoft/vscode chatInputModelUtils.ts), so report true for all models.
        // Converse tool calling was verified with Claude Haiku 4.5 and GPT-6 Astra (2026-09-25);
        // if another model does not support it, Bedrock returns ValidationException with the model ID and error code.
        capabilities: { toolCalling: true, imageInput: model.imageInput },
    };
}

/** A preset reports its underlying model's limits and capabilities; only the ID and generated name differ, and the effort is shown in the name. */
function presetChatInformation(entry: ResolvedPreset): vscode.LanguageModelChatInformation {
    return toChatInformation(entry.base, entry.id, entry.name);
}
