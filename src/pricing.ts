/**
 * Price table for cost estimates (pure functions; no API calls).
 *
 * Source: public AWS Price List Bulk API files; no sign-in or pricing:* permissions are required:
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/<region>/index.json
 * Verified on 2026-09-26: on-demand prices for Claude models are in this file; GPT-5.6 and GPT-6 are absent from all public Bedrock offers,
 * so users must enter GPT prices through amazonBedrockProvider.customPricing.
 * Prices are estimates only; actual charges are shown on the AWS bill.
 */

/** Price in USD per 1M tokens. */
export interface ModelPrice {
    readonly inputPerM: number;
    readonly outputPerM: number;
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
 * Entries without Global are Geo (standard prices outside cross-region profiles). Other billing types, such as batch, cache, and provisioned capacity, do not match and are skipped.
 */
const USAGE_PATTERN = /_(InputTokenCount|OutputTokenCount|input_tokens|output_tokens)(_Global|_global)?(_standard)?-Units$/;

interface OfferJson {
    publicationDate?: string;
    products?: Record<string, { attributes?: Record<string, string> }>;
    terms?: { OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, { unit?: string; pricePerUnit?: { USD?: string } }> }>> };
}

/** Parses a public price file and includes only models with both input and output prices. */
export function parseOffer(offer: unknown, region: string, source: string): PriceTable {
    const data = offer as OfferJson;
    const collected = new Map<string, { in?: number; out?: number; inGlobal?: number; outGlobal?: number }>();
    for (const [sku, product] of Object.entries(data.products ?? {})) {
        const attrs = product.attributes ?? {};
        const service = attrs.servicename ?? '';
        if (!EDITION_SUFFIX.test(service)) {
            continue;
        }
        const match = USAGE_PATTERN.exec(attrs.usagetype ?? '');
        if (!match) {
            continue;
        }
        const price = readUsdPerMillion(data, sku);
        if (price === undefined) {
            continue;
        }
        const name = service.replace(EDITION_SUFFIX, '');
        const entry = collected.get(name) ?? {};
        const isInput = match[1].toLowerCase().startsWith('input');
        const isGlobal = match[2] !== undefined;
        if (isInput) {
            entry[isGlobal ? 'inGlobal' : 'in'] = price;
        } else {
            entry[isGlobal ? 'outGlobal' : 'out'] = price;
        }
        collected.set(name, entry);
    }
    const models: Record<string, { geo: ModelPrice; global: ModelPrice }> = {};
    for (const [name, e] of collected) {
        if (e.in === undefined || e.out === undefined) {
            continue;
        }
        const geo = { inputPerM: e.in, outputPerM: e.out };
        // Older models have only one price; use it for both routes when no Global price is listed.
        const global = e.inGlobal !== undefined && e.outGlobal !== undefined ? { inputPerM: e.inGlobal, outputPerM: e.outGlobal } : geo;
        models[name] = { geo, global };
    }
    return { region, publicationDate: data.publicationDate ?? '', source, models };
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

export type PriceSource = 'custom' | 'table';

/**
 * Looks up a price in this order: user-defined price, then price table (matched by name).
 * If no foundation model is found, the model name may be a profile name (for example, "Anthropic Claude 3 Sonnet"),
 * so also try the name without the "Anthropic " prefix.
 * In-Region calls have no separate price and use the Geo price.
 */
export function lookupPrice(
    table: PriceTable | undefined,
    custom: CustomPrices,
    baseId: string,
    name: string,
    route: 'Geo' | 'Global' | 'In-Region',
): { price: ModelPrice; source: PriceSource } | undefined {
    const own = custom[baseId];
    if (own) {
        return { price: own, source: 'custom' };
    }
    const entry = table?.models[name] ?? table?.models[name.replace(/^Anthropic /, '')];
    if (!entry) {
        return undefined;
    }
    return { price: route === 'Global' ? entry.global : entry.geo, source: 'table' };
}

/** Estimates the cost in USD. */
export function estimateCost(inputTokens: number, outputTokens: number, price: ModelPrice): number {
    return (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000;
}
