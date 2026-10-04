import { estimateModelCost, lookupPrice, type CustomPrices, type PriceSource, type PriceTable, type RoutePrices } from './pricing';
import type { UsagePeriod } from './usage';

export interface UsageRow {
    readonly invokeId: string;
    readonly name: string;
    readonly route: string;
    readonly requests: number;
    /** Uncached input; with cache reads and writes it adds up to the total input. */
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    /** Undefined when no price is available. */
    readonly cost?: number;
    readonly priceSource?: PriceSource;
    /** A price exists, but part of it (cache or long-context tier) is unknown, so no cost is estimated. */
    readonly missingPrice?: 'cachePrice' | 'longContextPrice';
}

export interface UsageView {
    readonly profile: string;
    readonly region: string;
    readonly periodStart: string;
    readonly nextReset: string;
    readonly manualResetAt?: string;
    readonly rows: readonly UsageRow[];
    /** Total input including cache reads and writes. */
    readonly totalInput: number;
    readonly totalUncachedInput: number;
    readonly totalCacheRead: number;
    readonly totalCacheWrite: number;
    readonly totalOutput: number;
    /** Sum for models with prices. */
    readonly totalCost: number;
    /** False when any model has no price. */
    readonly pricedAll: boolean;
    readonly table?: { readonly publicationDate: string; readonly source: string };
}

/** Builds view data from period totals and the price table (pure function). Sorts by total input tokens. */
export function buildUsageView(
    profile: string,
    region: string,
    period: UsagePeriod,
    nextReset: Date,
    table: PriceTable | undefined,
    custom: CustomPrices,
    cards: ReadonlyMap<string, { readonly pricing?: RoutePrices }>,
): UsageView {
    const rows: UsageRow[] = Object.entries(period.models).map(([invokeId, m]) => {
        const found = lookupPrice(table, custom, cards, m.baseId, m.name, m.route);
        const cacheReadTokens = m.cacheReadTokens ?? 0;
        const cacheWriteTokens = m.cacheWriteTokens ?? 0;
        const estimate = found ? estimateModelCost(m, found.price) : undefined;
        return {
            invokeId,
            name: m.name,
            route: m.route,
            requests: m.requests,
            inputTokens: m.inputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens: m.outputTokens,
            cost: estimate && 'cost' in estimate ? estimate.cost : undefined,
            priceSource: found?.source,
            missingPrice: estimate && 'missing' in estimate ? estimate.missing : undefined,
        };
    });
    const totalOf = (r: UsageRow) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    rows.sort((a, b) => totalOf(b) - totalOf(a));
    return {
        profile,
        region,
        periodStart: period.periodStart,
        nextReset: nextReset.toISOString(),
        manualResetAt: period.manualResetAt,
        rows,
        totalInput: rows.reduce((s, r) => s + totalOf(r), 0),
        totalUncachedInput: rows.reduce((s, r) => s + r.inputTokens, 0),
        totalCacheRead: rows.reduce((s, r) => s + r.cacheReadTokens, 0),
        totalCacheWrite: rows.reduce((s, r) => s + r.cacheWriteTokens, 0),
        totalOutput: rows.reduce((s, r) => s + r.outputTokens, 0),
        totalCost: rows.reduce((s, r) => s + (r.cost ?? 0), 0),
        pricedAll: rows.every((r) => r.cost !== undefined),
        table: table ? { publicationDate: table.publicationDate, source: table.source } : undefined,
    };
}
