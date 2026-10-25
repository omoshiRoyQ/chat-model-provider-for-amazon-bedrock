import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePanel, renderCost } from '../src/usagePanel';
import type { UsageRow } from '../src/usageView';

const mocks = vi.hoisted(() => ({
    createWebviewPanel: vi.fn(),
    language: 'en',
    panel: undefined as undefined | {
        dispose: ReturnType<typeof vi.fn>;
        onDidDispose: ReturnType<typeof vi.fn>;
        reveal: ReturnType<typeof vi.fn>;
        webview: { cspSource: string; html: string; onDidReceiveMessage: ReturnType<typeof vi.fn> };
    },
}));

vi.mock('vscode', () => ({
    ViewColumn: { Active: 1 },
    env: { get language() { return mocks.language; } },
    l10n: { t: (message: string, ...args: unknown[]) => message.replace(/\{(\d+)\}/g, (match, index: string) => args[Number(index)] === undefined ? match : String(args[Number(index)])) },
    window: { createWebviewPanel: mocks.createWebviewPanel },
}));

function createPanel() {
    const panel = {
        dispose: vi.fn(),
        onDidDispose: vi.fn(),
        reveal: vi.fn(),
        webview: { cspSource: 'vscode-webview:', html: '', onDidReceiveMessage: vi.fn() },
    };
    mocks.panel = panel;
    mocks.createWebviewPanel.mockReturnValue(panel);
    return panel;
}

const view = (rows: UsageRow[] = []): Parameters<UsagePanel['show']>[0] => ({
    profile: 'test-profile',
    region: 'us-west-2',
    periodStart: '2026-10-01T00:00:00.000Z',
    nextReset: '2026-11-01T00:00:00.000Z',
    rows,
    totalInput: 0,
    totalUncachedInput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalOutput: 0,
    totalCost: 0,
    pricedAll: rows.every((row) => row.cost !== undefined),
});

beforeEach(() => {
    mocks.language = 'en';
    mocks.createWebviewPanel.mockReset();
    mocks.panel = undefined;
});

describe('renderCost', () => {
    it('labels costs from the AWS price table', () => {
        const row: UsageRow = {
            invokeId: 'global.anthropic.claude-opus-5-5',
            name: 'Claude Opus 5.5',
            route: 'Global',
            requests: 1,
            inputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 35_463,
            outputTokens: 931,
            cost: 0.195951,
            priceSource: 'table',
        };

        expect(renderCost(row)).toBe('$0.1960<div class="sub">price table</div>');
    });
});

describe('UsagePanel webview', () => {
    it('renders empty and missing-price views with themed keyboard focus styling and nonce CSP', () => {
        const panel = createPanel();
        const usagePanel = new UsagePanel({ reset: vi.fn(), updatePrices: vi.fn(), showLogs: vi.fn(), openPricingSettings: vi.fn() });
        const name = `<${'long-model-name-'.repeat(30)} & "quoted" 'name'>`;
        usagePanel.show(view([{
            invokeId: 'model<&>"\'',
            name,
            route: 'Global',
            requests: 1,
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
        }]));

        expect(panel.webview.html).toContain('button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }');
        expect(panel.webview.html).toContain('nonce="');
        expect(panel.webview.html).toContain(`style-src vscode-webview: 'nonce-`);
        expect(panel.webview.html).toContain('default-src \'none\';');
        expect(panel.webview.html).toContain(`&lt;${'long-model-name-'.repeat(30)} &amp; &quot;quoted&quot; &#39;name&#39;&gt;`);
        expect(panel.webview.html).toContain('model&lt;&amp;&gt;&quot;&#39;');
        expect(panel.webview.html).toContain('<span class="sub">No price data</span>');

        const emptyPanel = createPanel();
        new UsagePanel({ reset: vi.fn(), updatePrices: vi.fn(), showLogs: vi.fn(), openPricingSettings: vi.fn() }).show(view());
        expect(emptyPanel.webview.html).toContain('No usage in this period yet.');
    });

    it('dispatches only the four supported actions', () => {
        const panel = createPanel();
        const actions = { reset: vi.fn(), updatePrices: vi.fn(), showLogs: vi.fn(), openPricingSettings: vi.fn() };
        new UsagePanel(actions).show(view());
        const receive = panel.webview.onDidReceiveMessage.mock.calls[0][0] as (message: unknown) => void;

        for (const type of ['reset', 'updatePrices', 'showLogs', 'openPricingSettings']) receive({ type });
        receive({ type: 'unknown' });
        receive({});
        receive(undefined);

        expect(actions.reset).toHaveBeenCalledTimes(1);
        expect(actions.updatePrices).toHaveBeenCalledTimes(1);
        expect(actions.showLogs).toHaveBeenCalledTimes(1);
        expect(actions.openPricingSettings).toHaveBeenCalledTimes(1);
    });
});