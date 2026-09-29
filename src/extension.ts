import * as vscode from 'vscode';
import type { ResolvedModel } from './models';
import { PriceStore } from './priceStore';
import { AmazonBedrockProvider } from './provider';
import { CONFIG_SECTION, readSettings } from './settings';
import { SsoSignIn } from './signIn';
import { effortLabel, SignInStatusBar, ThinkingStatusBar, TokenStatusBar } from './statusBar';
import { THINKING_EFFORTS } from './thinking';
import { ThinkingStore } from './thinkingStore';
import { nextResetAt, UsageStore } from './usage';
import { UsagePanel } from './usagePanel';
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

    const usageStore = new UsageStore(context.globalState);
    const priceStore = new PriceStore(context.globalState);
    const thinkingStore = new ThinkingStore(context.globalState);
    const tokenBar = new TokenStatusBar();
    const thinkingBar = new ThinkingStatusBar();
    const signInBar = new SignInStatusBar();
    context.subscriptions.push(tokenBar, thinkingBar, signInBar);

    const provider = new AmazonBedrockProvider(log, signInBar, new SsoSignIn(log), {
        thinkingEffort: (modelId) => thinkingStore.get(modelId),
        onUsage: (profile, resolved, id, name, usage) => {
            const s = readSettings();
            const baseId = resolved?.baseId ?? id.replace(/^[a-z]+\.(?=[a-z]+\.)/, '');
            void usageStore
                .record(profile, id, { name, baseId, route: routeOf(id, resolved) }, usage, s.usageResetDay, s.usageResetHour)
                .then(refresh);
        },
    });

    const currentView = () => {
        const s = readSettings();
        const region = provider.region;
        const period = usageStore.get(s.profile, s.usageResetDay, s.usageResetHour);
        return buildUsageView(s.profile, region, period, nextResetAt(new Date(), s.usageResetDay, s.usageResetHour), region ? priceStore.get(region) : undefined, s.customPricing);
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
                await usageStore.reset(s.profile, s.usageResetDay, s.usageResetHour);
                log.info(`Usage totals manually reset for profile=${s.profile}`);
                refresh();
            }
        },
        updatePrices: async () => {
            const region = provider.region;
            if (!region) {
                void vscode.window.showWarningMessage(vscode.l10n.t('The region is not known yet. Open the Chat model picker once so the model list is loaded, then try again.'));
                return;
            }
            try {
                const table = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading Amazon Bedrock prices for {0}…', region) },
                    () => priceStore.download(region),
                );
                log.info(`Updated price table: region=${region}, models=${Object.keys(table.models).length}, publicationDate=${table.publicationDate}`);
                void vscode.window.showInformationMessage(
                    vscode.l10n.t('Prices updated: {0} models (published {1}).', Object.keys(table.models).length, table.publicationDate),
                );
                refresh();
            } catch (error) {
                const message = (error as Error).message;
                log.error(`Failed to update price table: ${message}`);
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not update prices: {0}', message));
            }
        },
        showLogs: () => log.show(),
        openPricingSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.customPricing`),
    });
    context.subscriptions.push(panel);

    function refresh(): void {
        const view = currentView();
        tokenBar.update(view.totalInput, view.totalOutput, view.rows.some((r) => r.cost !== undefined) ? view.totalCost : undefined);
        panel.refresh(view);
    }

    function refreshAfterSettingsChange(): void {
        const s = readSettings();
        void usageStore
            .configureResetSchedule(s.profile, s.usageResetDay, s.usageResetHour)
            .then(refresh)
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                log.error(`Failed to sync usage reset schedule: ${message}`);
                refresh();
            });
    }

    async function pickThinkingEffort(): Promise<void> {
        const choices = provider.models.filter((m) => m.thinking !== 'none');
        const resetAllLabel = vscode.l10n.t('Reset all models to Default…');
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
        vscode.commands.registerCommand('amazonBedrockProvider.showUsage', () => panel.show(currentView())),
        vscode.commands.registerCommand('amazonBedrockProvider.pickThinkingEffort', () => pickThinkingEffort()),
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
