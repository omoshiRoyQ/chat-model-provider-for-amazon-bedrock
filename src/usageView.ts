import { estimateCost, lookupPrice, type CustomPrices, type PriceSource, type PriceTable } from './pricing';
import type { UsagePeriod } from './usage';

export interface UsageRow {
    readonly invokeId: string;
    readonly name: string;
    readonly route: string;
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Undefined when no price is available. */
    readonly cost?: number;
    readonly priceSource?: PriceSource;
}

export interface UsageView {
    readonly profile: string;
    readonly region: string;
    readonly periodStart: string;
    readonly nextReset: string;
    readonly manualResetAt?: string;
    readonly rows: readonly UsageRow[];
    readonly totalInput: number;
    readonly totalOutput: number;
    /** Sum for models with prices. */
    readonly totalCost: number;
    /** False when any model has no price. */
    readonly pricedAll: boolean;
    readonly table?: { readonly publicationDate: string; readonly source: string };
}

/** Builds view data from period totals and the price table (pure function). Sorts by input-token count. */
export function buildUsageView(
    profile: string,
    region: string,
    period: UsagePeriod,
    nextReset: Date,
    table: PriceTable | undefined,
    custom: CustomPrices,
): UsageView {
    const rows: UsageRow[] = Object.entries(period.models).map(([invokeId, m]) => {
        const found = lookupPrice(table, custom, m.baseId, m.name, m.route);
        return {
            invokeId,
            name: m.name,
            route: m.route,
            requests: m.requests,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
            cost: found ? estimateCost(m.inputTokens, m.outputTokens, found.price) : undefined,
            priceSource: found?.source,
        };
    });
    rows.sort((a, b) => b.inputTokens - a.inputTokens);
    return {
        profile,
        region,
        periodStart: period.periodStart,
        nextReset: nextReset.toISOString(),
        manualResetAt: period.manualResetAt,
        rows,
        totalInput: rows.reduce((s, r) => s + r.inputTokens, 0),
        totalOutput: rows.reduce((s, r) => s + r.outputTokens, 0),
        totalCost: rows.reduce((s, r) => s + (r.cost ?? 0), 0),
        pricedAll: rows.every((r) => r.cost !== undefined),
        table: table ? { publicationDate: table.publicationDate, source: table.source } : undefined,
    };
}
