/**
 * Price table for cost estimates (pure functions; no API calls).
 *
 * Source: public AWS Price List Bulk API files; no sign-in or pricing:* permissions are required:
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/<region>/index.json
 * Checked 2026-10-04 (us-west-2): Claude and GPT-6 Astra are in this file; other GPT models are not.
 * Second source: the Pricing section of each AWS model card (modelCards.ts); GPT-6 Astra card prices matched this file exactly.
 * Prices are estimates only; actual charges are shown on the AWS bill.
 */

/** Price in USD per 1M tokens for one context tier. */
export interface TokenPrice {
    readonly inputPerM: number;
    readonly outputPerM: number;
    /** Undefined when no prompt-cache price is known; costs with cache tokens are then not estimated. */
    readonly cacheReadPerM?: number;
    readonly cacheWritePerM?: number;
}

export interface ModelPrice extends TokenPrice {
    /** Prices for requests above the model's long-context threshold; they apply to the whole request. */
    readonly longContext?: TokenPrice;
}

/** Model-card prices; a route is missing when the card does not list it. */
export interface RoutePrices {
    readonly geo?: ModelPrice;
    readonly global?: ModelPrice;
    readonly inRegion?: ModelPrice;
}

export interface PriceTable {
    readonly region: string;
    /** publicationDate from the price file. */
    readonly publicationDate: string;
    readonly source: string;
    /** Keyed by model name without the "(Amazon Bedrock Edition)" suffix, for example "Claude Opus 5.5". */
    readonly models: Readonly<Record<string, { readonly geo: ModelPrice; readonly global: ModelPrice }>>;
}

/** User-defined prices, keyed by foundation model ID (for example, openai.gpt-6-astra). */
export type CustomPrices = Readonly<Record<string, ModelPrice>>;

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** Accept only AWS region formats to avoid inserting arbitrary setting values into the URL. */
export function priceUrl(region: string): string | undefined {
    if (!REGION_PATTERN.test(region)) {
        return undefined;
    }
    return `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${region}/index.json`;
}

const EDITION_SUFFIX = / \(Amazon Bedrock Edition\)$/;

/**
 * The price file has two usagetype naming formats (observed in the 2026-09-25 data):
 * - Legacy: `USW2-MP:USW2_InputTokenCount-Units`, `..._InputTokenCount_Global-Units`
 * - Current: `USW2-MP:USW2_input_tokens_standard-Units`, `..._input_tokens_global_standard-Units`
 * Entries without Global are Geo (standard prices outside cross-region profiles).
 * Prompt-cache usagetypes (5-minute TTL): legacy `CacheReadInputTokenCount(_Global)`, `CacheWriteInputTokenCount(_Global)`;
 * current `cache_read_tokens(_global)_standard`, `cache_write_tokens(_global)_standard`.
 * 1-hour cache writes (`CacheWrite1hInputTokenCount`, `cache_write_tokens_1h_*`) are not used by this extension and do not match.
 * GPT-6 Astra (2026-10-04): 30-minute cache writes `cache_write_tokens_30m_*`, and a `_long_ctx` tier for every token type.
 * Other billing types, such as batch and provisioned capacity, do not match and are skipped.
 */
const USAGE_PATTERN =
    /_(InputTokenCount|OutputTokenCount|CacheReadInputTokenCount|CacheWriteInputTokenCount|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens)(_30m)?(_long_ctx)?(_Global|_global)?(_standard)?-Units$/;

type PriceKind = 'in' | 'out' | 'read' | 'write';

const KIND_BY_USAGE: Readonly<Record<string, PriceKind>> = {
    InputTokenCount: 'in',
    input_tokens: 'in',
    OutputTokenCount: 'out',
    output_tokens: 'out',
    CacheReadInputTokenCount: 'read',
    cache_read_tokens: 'read',
    CacheWriteInputTokenCount: 'write',
    cache_write_tokens: 'write',
};

interface OfferJson {
    publicationDate?: string;
    products?: Record<string, { attributes?: Record<string, string> }>;
    terms?: { OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, { unit?: string; pricePerUnit?: { USD?: string } }> }>> };
}

/** Parses a public price file and includes only models with both input and output prices. */
export function parseOffer(offer: unknown, region: string, source: string): PriceTable {
    type Tier = Partial<Record<PriceKind, number>>;
    type Route = { short: Tier; long: Tier };
    const data = offer as OfferJson;
    const collected = new Map<string, { geo: Route; global: Route }>();
    for (const [sku, product] of Object.entries(data.products ?? {})) {
        const attrs = product.attributes ?? {};
        const service = attrs.servicename ?? '';
        if (!EDITION_SUFFIX.test(service)) {
            continue;
        }
        const match = USAGE_PATTERN.exec(attrs.usagetype ?? '');
        const kind = match ? KIND_BY_USAGE[match[1]] : undefined;
        if (!match || !kind || (match[2] !== undefined && kind !== 'write')) {
            continue;
        }
        const price = readUsdPerMillion(data, sku);
        if (price === undefined) {
            continue;
        }
        const name = service.replace(EDITION_SUFFIX, '');
        const entry = collected.get(name) ?? { geo: { short: {}, long: {} }, global: { short: {}, long: {} } };
        const tier = entry[match[4] !== undefined ? 'global' : 'geo'][match[3] !== undefined ? 'long' : 'short'];
        // The 5-minute write price wins if a model ever lists both TTLs; Converse cache points use the 5-minute default.
        if (match[2] === undefined || tier.write === undefined) {
            tier[kind] = price;
        }
        collected.set(name, entry);
    }
    const toPrice = (route: Route): ModelPrice | undefined => {
        const short = toTokenPrice(route.short);
        const long = toTokenPrice(route.long);
        return short && (long ? { ...short, longContext: long } : short);
    };
    const models: Record<string, { geo: ModelPrice; global: ModelPrice }> = {};
    for (const [name, e] of collected) {
        const geo = toPrice(e.geo);
        if (!geo) {
            continue;
        }
        // Older models have only one price; use it for both routes when no Global price is listed.
        models[name] = { geo, global: toPrice(e.global) ?? geo };
    }
    return { region, publicationDate: data.publicationDate ?? '', source, models };
}

/** Cache prices are not borrowed from the other route or tier: a missing price must stay missing. */
function toTokenPrice(prices: Partial<Record<PriceKind, number>>): TokenPrice | undefined {
    if (prices.in === undefined || prices.out === undefined) {
        return undefined;
    }
    return {
        inputPerM: prices.in,
        outputPerM: prices.out,
        ...(prices.read !== undefined ? { cacheReadPerM: prices.read } : {}),
        ...(prices.write !== undefined ? { cacheWritePerM: prices.write } : {}),
    };
}

function readUsdPerMillion(data: OfferJson, sku: string): number | undefined {
    for (const term of Object.values(data.terms?.OnDemand?.[sku] ?? {})) {
        for (const dim of Object.values(term.priceDimensions ?? {})) {
            const usd = Number(dim.pricePerUnit?.USD);
            if (!Number.isFinite(usd)) {
                continue;
            }
            // The unit must be "1M tokens"; other units (such as per hour) are not token prices.
            if (dim.unit === '1M tokens') {
                return usd;
            }
        }
    }
    return undefined;
}

export type PriceSource = 'custom' | 'table' | 'modelCard';

/**
 * Looks up a price in this order: user-defined price, price table (matched by name), then model-card prices (by foundation model ID).
 * If no foundation model is found, the model name may be a profile name (for example, "Anthropic Claude 3 Sonnet"),
 * so also try the name without the "Anthropic " prefix.
 * In-Region calls use the price table's Geo price (it has no separate one), but only the In-Region row of a model card.
 */
export function lookupPrice(
    table: PriceTable | undefined,
    custom: CustomPrices,
    cards: ReadonlyMap<string, { readonly pricing?: RoutePrices }>,
    baseId: string,
    name: string,
    route: 'Geo' | 'Global' | 'In-Region',
): { price: ModelPrice; source: PriceSource } | undefined {
    const own = custom[baseId];
    if (own) {
        return { price: own, source: 'custom' };
    }
    const entry = table?.models[name] ?? table?.models[name.replace(/^Anthropic /, '')];
    if (entry) {
        return { price: route === 'Global' ? entry.global : entry.geo, source: 'table' };
    }
    const pricing = cards.get(baseId)?.pricing;
    const card = route === 'Global' ? pricing?.global : route === 'Geo' ? pricing?.geo : pricing?.inRegion;
    return card ? { price: card, source: 'modelCard' } : undefined;
}

interface TokenCounts {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}

/**
 * Estimates the cost in USD for one tier. inputTokens excludes cache tokens, which are priced separately.
 * Returns undefined when cache tokens were used but the matching cache price is unknown.
 */
export function estimateCost(usage: TokenCounts, price: TokenPrice): number | undefined {
    const read = usage.cacheReadTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    if ((read > 0 && price.cacheReadPerM === undefined) || (write > 0 && price.cacheWritePerM === undefined)) {
        return undefined;
    }
    return (
        usage.inputTokens * price.inputPerM +
        usage.outputTokens * price.outputPerM +
        read * (price.cacheReadPerM ?? 0) +
        write * (price.cacheWritePerM ?? 0)
    ) / 1_000_000;
}

export type CostEstimate = { readonly cost: number } | { readonly missing: 'cachePrice' | 'longContextPrice' };

/** Prices the totals: tokens from long-context requests (a subset of the totals) use the long-context tier, the rest the standard tier. */
export function estimateModelCost(usage: TokenCounts & { readonly longContext?: TokenCounts }, price: ModelPrice): CostEstimate {
    const long = usage.longContext;
    const longTokens = long ? long.inputTokens + long.outputTokens + (long.cacheReadTokens ?? 0) + (long.cacheWriteTokens ?? 0) : 0;
    if (longTokens > 0 && !price.longContext) {
        return { missing: 'longContextPrice' };
    }
    const standard = {
        inputTokens: usage.inputTokens - (long?.inputTokens ?? 0),
        outputTokens: usage.outputTokens - (long?.outputTokens ?? 0),
        cacheReadTokens: (usage.cacheReadTokens ?? 0) - (long?.cacheReadTokens ?? 0),
        cacheWriteTokens: (usage.cacheWriteTokens ?? 0) - (long?.cacheWriteTokens ?? 0),
    };
    const standardCost = estimateCost(standard, price);
    const longCost = long && price.longContext ? estimateCost(long, price.longContext) : 0;
    return standardCost === undefined || longCost === undefined ? { missing: 'cachePrice' } : { cost: standardCost + longCost };
}
