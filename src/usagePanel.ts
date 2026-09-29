import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { UsageView } from './usageView';

/** Messages sent from the panel buttons to the extension. */
type PanelMessage = { type: 'reset' } | { type: 'updatePrices' } | { type: 'showLogs' } | { type: 'openPricingSettings' };

export interface UsagePanelActions {
    reset(): Promise<void>;
    updatePrices(): Promise<void>;
    showLogs(): void;
    openPricingSettings(): void;
}

/**
 * Webview panel for token and request totals. Only one panel is open at a time; refresh it after each completed request.
 * Security: the CSP allows only nonce-bearing inline scripts and VS Code-provided styles; no external resources are loaded.
 * Escape all dynamic text as HTML and accept only the defined message types from the panel.
 */
export class UsagePanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;

    constructor(private readonly actions: UsagePanelActions) { }

    show(view: UsageView): void {
        if (this.panel) {
            this.panel.reveal();
        } else {
            this.panel = vscode.window.createWebviewPanel('amazonBedrockProvider.usage', vscode.l10n.t('Amazon Bedrock Usage'), vscode.ViewColumn.Active, {
                enableScripts: true,
                localResourceRoots: [],
            });
            this.panel.onDidDispose(() => (this.panel = undefined));
            this.panel.webview.onDidReceiveMessage((m: PanelMessage) => this.onMessage(m));
        }
        this.render(view);
    }

    /** Refresh only while the panel is open. */
    refresh(view: UsageView): void {
        if (this.panel) {
            this.render(view);
        }
    }

    dispose(): void {
        this.panel?.dispose();
    }

    private onMessage(message: PanelMessage): void {
        switch (message?.type) {
            case 'reset':
                void this.actions.reset();
                break;
            case 'updatePrices':
                void this.actions.updatePrices();
                break;
            case 'showLogs':
                this.actions.showLogs();
                break;
            case 'openPricingSettings':
                this.actions.openPricingSettings();
                break;
        }
    }

    private render(view: UsageView): void {
        if (!this.panel) {
            return;
        }
        const nonce = randomBytes(16).toString('base64');
        this.panel.webview.html = renderHtml(view, nonce, this.panel.webview.cspSource);
    }
}

function esc(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const num = (n: number) => n.toLocaleString();
const usd = (n: number) => `$${n.toFixed(4)}`;
const date = (iso: string) => iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');

function renderHtml(view: UsageView, nonce: string, cspSource: string): string {
    const t = vscode.l10n.t;
    const rows = view.rows
        .map(
            (r) => `<tr>
  <td>${esc(r.name)}<div class="sub">${esc(r.invokeId)}</div></td>
  <td>${esc(r.route)}</td>
  <td class="n">${num(r.requests)}</td>
  <td class="n">${num(r.inputTokens)}</td>
  <td class="n">${num(r.outputTokens)}</td>
  <td class="n">${r.cost !== undefined ? usd(r.cost) + (r.priceSource === 'custom' ? ` <span class="sub">${esc(t('custom'))}</span>` : '') : `<span class="sub">${esc(t('No price data'))}</span>`}</td>
</tr>`,
        )
        .join('\n');
    const empty = view.rows.length === 0 ? `<tr><td colspan="6" class="sub">${esc(t('No usage in this period yet.'))}</td></tr>` : '';
    const tableInfo = view.table
        ? esc(t('Price table: {0} (published {1}).', view.table.source, date(view.table.publicationDate)))
        : esc(t('No price table for region {0}. Click "Update Prices" to download it.', view.region));
    const costNote = view.pricedAll ? '' : ` <span class="sub">${esc(t('(models without price data are excluded)'))}</span>`;
    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
<h2>${esc(t('Amazon Bedrock Usage'))}</h2>
<p>${esc(t('Profile: {0} · Region: {1}', view.profile, view.region || '—'))}<br>
<span class="sub">${esc(t('Period: {0} → next reset {1}', date(view.periodStart), date(view.nextReset)))}${view.manualResetAt ? ' · ' + esc(t('manually reset at {0}', date(view.manualResetAt))) : ''}</span></p>
<table>
<thead><tr>
  <th>${esc(t('Model'))}</th><th>${esc(t('Route'))}</th><th class="n">${esc(t('Requests'))}</th>
  <th class="n">${esc(t('Input tokens'))}</th><th class="n">${esc(t('Output tokens'))}</th><th class="n">${esc(t('Estimated cost (USD)'))}</th>
</tr></thead>
<tbody>
${rows}${empty}
</tbody>
<tfoot><tr>
  <td>${esc(t('Total'))}</td><td></td><td class="n">${num(view.rows.reduce((s, r) => s + r.requests, 0))}</td>
  <td class="n">${num(view.totalInput)}</td><td class="n">${num(view.totalOutput)}</td><td class="n">${usd(view.totalCost)}${costNote}</td>
</tr></tfoot>
</table>
<p class="sub">${tableInfo}<br>${esc(t('Estimates only. Actual charges are shown on your AWS bill.'))}</p>
<div class="actions">
  <button data-action="updatePrices">${esc(t('Update Prices'))}</button>
  <button data-action="openPricingSettings" class="secondary">${esc(t('Custom Prices…'))}</button>
  <button data-action="reset" class="secondary">${esc(t('Reset Usage…'))}</button>
  <button data-action="showLogs" class="secondary">${esc(t('Show Logs'))}</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const button of document.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.action }));
  }
</script>
</body>
</html>`;
}
