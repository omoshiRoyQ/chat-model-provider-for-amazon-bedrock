import * as vscode from 'vscode';
import { addCachePoints, buildToolConfig, toConverseMessages, toConverseSystem } from './convert';
import { describeError, describeErrorForLog, isCredentialError, isSystemMessageUnsupported } from './errors';
import { fetchModelSources } from './modelList';
import type { ModelCardStore } from './modelCardStore';
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
    private listCache: { key: string; promise: Promise<ResolvedModel[]> } | undefined;
    /** Models from the most recent successful query, indexed by the model ID seen by VS Code. */
    private modelsById = new Map<string, ResolvedModel>();
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
        this.configListener.dispose();
        this.changeEmitter.dispose();
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const settings = readSettings();
        if (!settings.profile) {
            // VS Code queries the model list frequently; log this state only once to avoid flooding the output.
            if (!this.warnedMissingProfile) {
                this.log.warn(`No AWS profile is configured at ${CONFIG_SECTION}.profile; no models will be returned`);
                this.warnedMissingProfile = true;
            }
            return [];
        }
        try {
            const models = await this.listModels(settings);
            this.lastModelListErrorKey = undefined;
            this.clearCredentialProblem();
            return models.map(toChatInformation);
        } catch (error) {
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
    private listModels(settings: BedrockSettings): Promise<ResolvedModel[]> {
        const key = [settings.profile, settings.region, settings.inferenceScope, settings.modelFilter].join('|');
        if (this.listCache?.key === key) {
            return this.listCache.promise;
        }
        const promise = (async () => {
            this.log.info(`Loading model list: profile=${settings.profile}, scope=${settings.inferenceScope}, modelFilter=${settings.modelFilter}`);
            const sources = await fetchModelSources(settings.profile, settings.region);
            this.resolvedRegion = sources.region;
            this.log.info(`Resolved region=${sources.region} (${settings.region ? 'from settings' : 'from profile'})`);
            if (sources.foundationsDenied) {
                this.log.warn(`AWS profile "${settings.profile}" lacks bedrock:ListFoundationModels; listing inference profiles only and assuming image input is supported`);
            }
            const { models, notes, unknownIds, usesModelCards } = resolveModels(
                sources.profiles,
                sources.foundations,
                settings.inferenceScope,
                settings.modelFilter === 'claudeAndGpt',
                this.modelCards.limits(),
            );
            for (const note of notes) {
                this.log.info(note);
            }
            this.log.info(`Reported ${models.length} models (inference profiles=${sources.profiles.length}, foundation models=${sources.foundations.length}, imageInput=${models.filter((m) => m.imageInput).length})`);
            this.modelsById = new Map(models.map((m) => [m.invokeId, m]));
            if ((unknownIds.length > 0 || usesModelCards) && this.modelCards.needsRefresh(unknownIds)) {
                this.refreshModelCards(unknownIds);
            }
            return models;
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

    /** Runs in the background so the model list is not delayed; reloads the list when new card data arrives. */
    private refreshModelCards(unknownIds: readonly string[]): void {
        this.log.info(`Fetching AWS model cards (models without catalog or card data: ${unknownIds.join(', ') || 'none'})`);
        this.modelCards.refresh(unknownIds).then(
            ({ fetched, failed }) => {
                this.log.info(`Model cards updated: fetched=${fetched}${failed.length > 0 ? `, failed=${failed.join(', ')}` : ''}`);
                if (fetched > 0) {
                    this.listCache = undefined;
                    this.changeEmitter.fire();
                }
            },
            (error: unknown) => {
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
        const resolved = this.modelsById.get(model.id);
        const imageInput = resolved?.imageInput ?? model.capabilities.imageInput ?? false;
        const systemAsUser = this.noSystemModels.has(model.id);
        const system = systemAsUser ? undefined : toConverseSystem(messages);
        const converseMessages = toConverseMessages(messages, this.log, imageInput, systemAsUser);
        const toolConfig = buildToolConfig(options.tools, options.toolMode, converseMessages);
        const effort = this.hooks.thinkingEffort(model.id);
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
            this.log.info(`model=${model.id} thinking: ${thinking.note}`);
        }
        const images = converseMessages.reduce((n, m) => n + (m.content?.filter((b) => b.image).length ?? 0), 0);
        // Raw VS Code roles (1=user, 2=assistant; other values are not in the stable API) before merging.
        const roles = [...messages.reduce((m, x) => m.set(x.role, (m.get(x.role) ?? 0) + 1), new Map<number, number>())].map(([r, n]) => `${r}:${n}`).join(',');
        const promptCache = resolved?.promptCache ?? false;
        this.log.info(
            `Sending request: model=${model.id}, path=Native, messages=${converseMessages.length}, roles=${roles}, system=${system ? 'field' : systemAsUser ? 'as-user' : 'none'}, images=${images}, tools=${options.tools?.length ?? 0}, toolConfig=${toolConfig ? toolConfig.tools?.length : 'none'}, thinkingEffort=${effort}, fields=${thinking.fields ? JSON.stringify(thinking.fields) : 'none'}, promptCache=${promptCache}`,
        );
        const withCache = <T extends Parameters<typeof addCachePoints>[0]>(r: T): T => (promptCache ? addCachePoints(r) : r);
        const baseRequest = {
            profile: settings.profile,
            region: settings.region,
            modelId: model.id,
            messages: converseMessages,
            system,
            toolConfig,
            additionalFields: thinking.fields,
            maxTokens: thinking.maxTokens,
        };
        const request = withCache(baseRequest);
        const tagFilter = model.id.includes('amazon.nova-') ? new ThinkingTagFilter() : undefined;
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
                this.log.info(`model=${model.id} called tool: ${part.name} (callId=${part.callId})`);
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
                this.noSystemModels.add(model.id);
                this.log.warn(`model=${model.id} does not support system messages; resending with the system prompt as user text`);
                const merged = toConverseMessages(messages, this.log, imageInput, true);
                usage = await this.native.stream(withCache({ ...baseRequest, messages: merged, system: undefined }), onPart, token);
            }
            if (tagFilter) {
                reportText(tagFilter.flush());
                if (tagFilter.removed > 0) {
                    this.log.info(`model=${model.id} removed ${tagFilter.removed} characters of <thinking> text`);
                }
            }
            this.clearCredentialProblem();
            if (usage) {
                this.hooks.onUsage(settings.profile, resolved, model.id, model.name, usage);
            }
        } catch (error) {
            if (token.isCancellationRequested) {
                this.log.info(`model=${model.id} request cancelled by user`);
                return;
            }
            const message = describeError(error, model.id, 'Native', settings.profile);
            this.log.error(describeErrorForLog(error, model.id, 'Native', settings.profile));
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

function toChatInformation(model: ResolvedModel): vscode.LanguageModelChatInformation {
    return {
        id: model.invokeId,
        name: model.name,
        family: model.baseId,
        version: model.baseId,
        // VS Code's maxInputTokens is the input limit; subtract the output allowance from the context window.
        maxInputTokens: model.contextWindow - model.maxOutputTokens,
        maxOutputTokens: model.maxOutputTokens,
        detail: `Native · ${model.route}`,
        tooltip: model.invokeId,
        // Current VS Code Agent, Ask, and Plan modes list only models with toolCalling=true
        // (see isModelSupportedForMode in microsoft/vscode chatInputModelUtils.ts), so report true for all models.
        // Converse tool calling was verified with Claude Haiku 4.5 and GPT-6 Astra (2026-09-25);
        // if another model does not support it, Bedrock returns ValidationException with the model ID and error code.
        capabilities: { toolCalling: true, imageInput: model.imageInput },
    };
}
