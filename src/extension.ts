import * as vscode from 'vscode';
import { ModelCardStore } from './modelCardStore';
import { pickModelVisibility } from './modelFilter';
import { pickModelPresets } from './modelPresets';
import type { ResolvedModel } from './models';
import { PriceStore } from './priceStore';
import { AmazonBedrockProvider } from './provider';
import { CONFIG_SECTION, readSettings } from './settings';
import { SsoSignIn } from './signIn';
import { createSharedModelCardBacking, createSharedPriceBacking } from './sharedStorage';
import { effortLabel, SignInStatusBar, ThinkingStatusBar, TokenStatusBar } from './statusBar';
import { THINKING_EFFORTS } from './thinking';
import { ThinkingStore } from './thinkingStore';
import { isLongContext, nextResetAt, totalInputTokens, UsageStore } from './usage';
import { UsagePanel } from './usagePanel';
import { createSharedUsageBacking, ResetTimer } from './usageStorage';
import { buildUsageView } from './usageView';

// Must match package.json contributes.languageModelChatProviders[].vendor.
const VENDOR = 'amazon-bedrock-provider';

/** Infers the route from the invocation model ID: `global.` means Global, other prefixed IDs mean Geo, and unprefixed IDs use the current region directly. */
function routeOf(modelId: string, resolved: ResolvedModel | undefined): 'Geo' | 'Global' | 'In-Region' {
    if (resolved) {
        return resolved.route;
    }
    if (modelId.startsWith('global.')) {
        return 'Global';
    }
    return /^[a-z]+\.[a-z]+\./.test(modelId) ? 'Geo' : 'In-Region';
}

export function activate(context: vscode.ExtensionContext): void {
    const log = vscode.window.createOutputChannel('Chat Model Provider for Amazon Bedrock', { log: true });
    context.subscriptions.push(log);

    const sharedBacking = createSharedUsageBacking(context.globalStorageUri, () => refresh(), log);
    // Prices and model cards live in the same Default Profile directory as usage; a download in any VS Code Profile refreshes the others.
    const sharedPriceBacking = createSharedPriceBacking(context.globalStorageUri, () => refresh(), log);
    const sharedCardBacking = createSharedModelCardBacking(context.globalStorageUri, () => {
        provider.syncExternalModelCards();
        refresh();
    }, log);
    const usageStore = new UsageStore(context.globalState, sharedBacking);
    const priceStore = new PriceStore(context.globalState, sharedPriceBacking);
    const thinkingStore = new ThinkingStore(context.globalState);
    const modelCards = new ModelCardStore(context.globalState, sharedCardBacking);
    const tokenBar = new TokenStatusBar();
    const thinkingBar = new ThinkingStatusBar();
    const signInBar = new SignInStatusBar();
    const resetTimer = new ResetTimer(() => {
        refreshAfterSettingsChange();
    });
    context.subscriptions.push(usageStore, resetTimer, tokenBar, thinkingBar, signInBar);
    for (const backing of [sharedPriceBacking, sharedCardBacking]) {
        if (backing) {
            context.subscriptions.push(backing);
        }
    }
    const migratedPriceRegions = new Set<string>();
    const warnMigration = (what: string) => (error: unknown) => log.warn(`Could not migrate saved ${what} to shared storage: ${error instanceof Error ? error.message : String(error)}`);
    void modelCards.migrateLegacy().then(() => refresh()).catch(warnMigration('model cards'));

    const provider = new AmazonBedrockProvider(log, signInBar, new SsoSignIn(log), {
        thinkingEffort: (modelId) => thinkingStore.get(modelId),
        onUsage: (profile, resolved, id, name, usage) => {
            const s = readSettings();
            const baseId = resolved?.baseId ?? id.replace(/^[a-z]+\.(?=[a-z]+\.)/, '');
            const longContext = isLongContext(usage, resolved?.longContextThreshold);
            if (longContext) {
                const total = totalInputTokens(usage);
                log.info(`model=${id} long-context request: total input ${total} > threshold ${resolved?.longContextThreshold}`);
            }
            void usageStore
                .record(profile, id, { name, baseId, route: routeOf(id, resolved) }, usage, s.usageResetDay, s.usageResetHour, new Date(), longContext)
                .then(() => refresh())
                .catch(() => log.error('Could not record shared usage.'));
        },
    }, modelCards);

    const currentView = (now = new Date()) => {
        const s = readSettings();
        const region = provider.region;
        const period = usageStore.get(s.profile, s.usageResetDay, s.usageResetHour, now);
        return buildUsageView(s.profile, region, period, nextResetAt(now, s.usageResetDay, s.usageResetHour), region ? priceStore.get(region) : undefined, s.customPricing, modelCards.limits());
    };

    const panel = new UsagePanel({
        reset: async () => {
            const s = readSettings();
            const reset = vscode.l10n.t('Reset');
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('Reset the usage totals for profile "{0}"? This cannot be undone.', s.profile),
                { modal: true },
                reset,
            );
            if (choice === reset) {
                try {
                    await usageStore.reset(s.profile, s.usageResetDay, s.usageResetHour);
                    log.info(`Usage totals manually reset for profile=${s.profile}`);
                    refresh();
                } catch {
                    log.error('Could not reset shared usage.');
                    log.show();
                }
            }
        },
        updatePrices: async () => {
            const region = provider.region;
            if (!region) {
                void vscode.window.showWarningMessage(vscode.l10n.t('The region is not known yet. Open the Chat model picker once so the model list is loaded, then try again.'));
                return;
            }
            const { proxyUrl } = readSettings();
            // Model-card prices cover models missing from the price file (most GPT models as of 2026-10-04).
            const [tableResult, cardResult] = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading Amazon Bedrock prices for {0}', region) },
                () => Promise.allSettled([priceStore.download(region, proxyUrl), modelCards.refresh([], Date.now(), true, proxyUrl)]),
            );
            if (cardResult.status === 'fulfilled') {
                provider.refreshModelList();
                const { fetched, failed } = cardResult.value;
                log.info(`Model cards updated for pricing: fetched=${fetched}${failed.length > 0 ? `, failed=${failed.join(', ')}` : ''}`);
            } else {
                log.warn(`Could not update model-card prices: ${(cardResult.reason as Error).message}`);
            }
            if (tableResult.status === 'fulfilled') {
                const table = tableResult.value;
                log.info(`Updated price table: region=${region}, models=${Object.keys(table.models).length}, publicationDate=${table.publicationDate}`);
                void vscode.window.showInformationMessage(
                    vscode.l10n.t('Prices updated: {0} models (published {1}).', Object.keys(table.models).length, table.publicationDate),
                );
            } else {
                const message = (tableResult.reason as Error).message;
                log.error(`Failed to update price table: ${message}`);
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not update prices: {0}', message));
            }
            refresh();
        },
        showLogs: () => log.show(),
        openPricingSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.customPricing`),
    });
    context.subscriptions.push(panel);

    function refresh(now = new Date()): ReturnType<typeof currentView> {
        const s = readSettings();
        const region = provider.region;
        if (region && !migratedPriceRegions.has(region)) {
            // Once per region and session: move a table saved by an older version into shared storage.
            migratedPriceRegions.add(region);
            void priceStore.migrateLegacy(region).then(() => refresh()).catch(warnMigration('prices'));
        }
        const view = currentView(now);
        tokenBar.update(view.totalInput, view.totalOutput, view.rows.some((r) => r.cost !== undefined) ? view.totalCost : undefined);
        panel.refresh(view);
        resetTimer.schedule(nextResetAt(now, s.usageResetDay, s.usageResetHour));
        return view;
    }

    function refreshAfterSettingsChange(): void {
        const s = readSettings();
        void usageStore
            .configureResetSchedule(s.profile, s.usageResetDay, s.usageResetHour)
            .then(() => refresh())
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                log.error(`Failed to sync usage reset schedule: ${message}`);
                refresh();
            });
    }

    async function pickThinkingEffort(): Promise<void> {
        const choices = provider.models.filter((m) => m.thinking !== 'none');
        const resetAllLabel = vscode.l10n.t('Reset all models to Default');
        const items: (vscode.QuickPickItem & { model?: ResolvedModel; resetAll?: boolean })[] = [
            ...choices.map((model) => ({
                label: model.name,
                description: `${model.route} · ${effortLabel(thinkingStore.get(model.invokeId))}`,
                model,
            })),
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: resetAllLabel, resetAll: true },
        ];
        const pickedModel = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Choose a model or reset settings') });
        if (!pickedModel) {
            return;
        }
        if (pickedModel.resetAll) {
            const resetLabel = vscode.l10n.t('Reset All');
            const confirmation = await vscode.window.showWarningMessage(
                vscode.l10n.t('Reset all saved thinking effort values to Default for every Bedrock model?'),
                { modal: true },
                resetLabel,
            );
            if (confirmation === resetLabel) {
                await thinkingStore.resetAll();
                log.info('Reset thinking effort to default for all models');
            }
            return;
        }
        const target = pickedModel.model;
        if (!target) {
            return;
        }
        const current = thinkingStore.get(target.invokeId);
        const effortItems = THINKING_EFFORTS.map((effort) => ({
            label: effortLabel(effort),
            description: effort === current ? vscode.l10n.t('current') : undefined,
            effort,
        }));
        const picked = await vscode.window.showQuickPick(effortItems, { title: vscode.l10n.t('Thinking effort for {0}', target.name) });
        if (!picked) {
            return;
        }
        await thinkingStore.set(target.invokeId, picked.effort);
        log.info(`model=${target.invokeId} thinking effort set to ${picked.effort}`);
    }

    context.subscriptions.push(
        // Let users open the output panel from the Command Palette and activate the extension directly.
        vscode.commands.registerCommand('amazonBedrockProvider.showLogs', () => log.show()),
        vscode.commands.registerCommand('amazonBedrockProvider.signIn', () => provider.signIn()),
        vscode.commands.registerCommand('amazonBedrockProvider.showUsage', () => {
            const view = refresh();
            panel.show(view);
        }),
        vscode.commands.registerCommand('amazonBedrockProvider.pickThinkingEffort', () => pickThinkingEffort()),
        vscode.commands.registerCommand('amazonBedrockProvider.pickModelVisibility', () => pickModelVisibility(() => vscode.workspace.getConfiguration(CONFIG_SECTION), log)),
        vscode.commands.registerCommand('amazonBedrockProvider.manageModelPresets', () => pickModelPresets(() => vscode.workspace.getConfiguration(CONFIG_SECTION), () => provider.models, log)),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                refreshAfterSettingsChange();
            }
        }),
        provider,
        vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    );

    refreshAfterSettingsChange();
    log.info(`Extension activated; registered vendor=${VENDOR}`);
}

export function deactivate(): void {
    // All resources are disposed through context.subscriptions, so no additional cleanup is needed here.
}
