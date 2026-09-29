import * as vscode from 'vscode';
import type { ThinkingEffort } from './thinking';

/** Shows current-period token totals in the status bar; selecting it opens the usage panel. */
export class TokenStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        // 20.01-20.03 keeps these items adjacent and clear of VS Code's editor status items (100.1-100.5).
        this.item = vscode.window.createStatusBarItem('amazonBedrockProvider.tokens', vscode.StatusBarAlignment.Right, 20.02);
        this.item.name = vscode.l10n.t('Chat Model Provider for Amazon Bedrock token usage');
        this.item.command = 'amazonBedrockProvider.showUsage';
    }

    /** Show 0 / 0 even when no tokens have been used during the current period. */
    update(inputTokens: number, outputTokens: number, estimatedCost: number | undefined): void {
        this.item.text = `$(hubot) ${formatTokens(inputTokens)} / ${formatTokens(outputTokens)}`;
        const cost = estimatedCost !== undefined ? vscode.l10n.t('Estimated cost: ${0}', estimatedCost.toFixed(2)) : '';
        this.item.tooltip = [
            vscode.l10n.t('This period: {0} input tokens, {1} output tokens.', inputTokens.toLocaleString(), outputTokens.toLocaleString()),
            cost,
            vscode.l10n.t('Click to show usage details.'),
        ]
            .filter((line) => line !== '')
            .join('\n');
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
    }
}

/** Formats 25495 as 25.5K; values below 1000 are shown as-is. */
export function formatTokens(n: number): string {
    if (n < 1_000) {
        return String(n);
    }
    if (n < 1_000_000) {
        return `${(n / 1_000).toFixed(1)}K`;
    }
    return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Display label for a thinking effort level. */
export function effortLabel(effort: ThinkingEffort): string {
    switch (effort) {
        case 'default':
            return vscode.l10n.t('Default');
        case 'off':
            return vscode.l10n.t('Off');
        case 'low':
            return vscode.l10n.t('Low');
        case 'medium':
            return vscode.l10n.t('Medium');
        case 'high':
            return vscode.l10n.t('High');
        case 'xhigh':
            return vscode.l10n.t('Extra High');
        case 'max':
            return vscode.l10n.t('Max');
    }
}

/** Shows a persistent thinking-settings button so an unsent Chat model selection cannot leave the previous model's effort displayed. */
export class ThinkingStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem('amazonBedrockProvider.thinking', vscode.StatusBarAlignment.Right, 20.01);
        this.item.name = vscode.l10n.t('Chat Model Provider for Amazon Bedrock thinking effort');
        this.item.command = 'amazonBedrockProvider.pickThinkingEffort';
        this.item.text = `$(lightbulb) ${vscode.l10n.t('Thinking Effort')}`;
        this.item.tooltip = vscode.l10n.t('Click to configure thinking effort.');
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
    }
}

/** Shows a Sign in button in the status bar when credentials expire or become invalid; hides it after recovery. */
export class SignInStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem('amazonBedrockProvider.signIn', vscode.StatusBarAlignment.Right, 20.03);
        this.item.name = vscode.l10n.t('Chat Model Provider for Amazon Bedrock sign-in');
        this.item.command = 'amazonBedrockProvider.signIn';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    show(profile: string): void {
        this.item.text = `$(key) ${vscode.l10n.t('Bedrock: Sign in')}`;
        this.item.tooltip = vscode.l10n.t('AWS credentials for profile "{0}" are expired or invalid. Click to run `aws sso login`.', profile);
        this.item.show();
    }

    hide(): void {
        this.item.hide();
    }

    dispose(): void {
        this.item.dispose();
    }
}
