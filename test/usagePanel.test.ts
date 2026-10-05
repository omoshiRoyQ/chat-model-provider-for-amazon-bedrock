import { describe, expect, it } from 'vitest';
import { renderCost } from '../src/usagePanel';
import type { UsageRow } from '../src/usageView';

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