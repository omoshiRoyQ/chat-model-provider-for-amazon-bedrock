/**
 * Parses AWS Bedrock model-card pages (public documentation; pure functions, no network access).
 * The pages are written for people, not as an API, so every field is optional and parse failures leave it undefined.
 * Page layout verified on 2026-10-01 against the markdown versions of the Claude, GPT, and Llama model cards.
 */

import type { ModelPrice, RoutePrices, TokenPrice } from './pricing';

export const MODEL_CARD_BASE_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/';
/** Table of contents of the Bedrock user guide; lists every model-card page. */
export const MODEL_CARD_INDEX_URL = `${MODEL_CARD_BASE_URL}toc-contents.json`;

export interface ModelCard {
    readonly card: string;
    /** Foundation model IDs (without inference-profile prefixes) listed for the bedrock-runtime endpoint. */
    readonly runtimeIds: readonly string[];
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly textOutput: boolean;
    /** Whether bedrock-runtime lists the Converse API; undefined when the page has no API table. */
    readonly converse?: boolean;
    /** Input tokens above which long-context prices apply to the whole request (from the Pricing section). */
    readonly longContextThreshold?: number;
    /** Standard-tier commercial prices from the Pricing section; undefined when the card has no price table. */
    readonly pricing?: RoutePrices;
}

/** Card names become part of a URL, so only this character set is accepted from the index. */
const CARD_NAME = /"(model-card-[a-z0-9-]+)\.html"/g;
const MODEL_ID = /^[a-z0-9-]+\.[a-z0-9.:_-]+$/i;

export function modelCardNames(indexText: string): string[] {
    return [...new Set([...indexText.matchAll(CARD_NAME)].map((m) => m[1]))].sort();
}

export function modelCardUrl(card: string): string {
    return `${MODEL_CARD_BASE_URL}${card}.md`;
}

export const PROMPT_CACHING_URL = `${MODEL_CARD_BASE_URL}prompt-caching.md`;

/**
 * Model IDs in the explicit prompt caching table whose checkpoint fields include Converse `messages` (layout verified 2026-10-04).
 * GPT-5.6 rows accept checkpoints only through the Responses API, so they are excluded. Undefined when the table is not found.
 */
export function converseCacheModelIds(markdown: string): string[] | undefined {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith('|') && l.includes('Model ID') && l.includes('Fields that accept'));
    if (start < 0) {
        return undefined;
    }
    const header = cells(lines[start]).map((c) => c.replace(/\*/g, '').trim());
    const idColumn = header.indexOf('Model ID');
    const fieldsColumn = header.findIndex((h) => h.startsWith('Fields that accept'));
    const result: string[] = [];
    for (const line of lines.slice(start + 2)) {
        if (!line.startsWith('|')) {
            break;
        }
        const row = cells(line);
        if (row[fieldsColumn]?.includes('`messages`') && MODEL_ID.test(row[idColumn] ?? '')) {
            result.push(row[idColumn]);
        }
    }
    return result;
}

/** Parses values such as "1M tokens", "128K", or "1,050,000 tokens"; K and M are decimal, matching the catalog. */
export function parseTokenCount(text: string): number | undefined {
    const m = /^(\d[\d,]*(?:\.\d+)?)\s*([KM])?\b/i.exec(text.trim());
    if (!m) {
        return undefined;
    }
    const unit = m[2]?.toUpperCase();
    const value = Math.round(Number(m[1].replace(/,/g, '')) * (unit === 'M' ? 1_000_000 : unit === 'K' ? 1_000 : 1));
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

function detail(markdown: string, label: string): number | undefined {
    const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`).exec(markdown);
    return m ? parseTokenCount(m[1]) : undefined;
}

function cells(line: string): string[] {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Rows of the first markdown table whose header contains the given column name. */
function table(lines: readonly string[], column: string): { header: string[]; rows: string[][] } | undefined {
    const start = lines.findIndex((l) => l.startsWith('|') && l.includes(`**${column}**`));
    if (start < 0) {
        return undefined;
    }
    const header = cells(lines[start]).map((c) => c.replace(/\*/g, '').trim());
    const rows: string[][] = [];
    for (const line of lines.slice(start + 2)) {
        if (!line.startsWith('|')) {
            break;
        }
        rows.push(cells(line));
    }
    return { header, rows };
}

function ids(cell: string | undefined, stripPrefix: boolean): string[] {
    return (cell ?? '')
        .split(/<br\s*\/?>/i)
        .map((s) => s.replace(/`/g, '').trim())
        .filter((s) => MODEL_ID.test(s))
        .map((s) => (stripPrefix ? s.slice(s.indexOf('.') + 1) : s));
}

function converseSupport(lines: readonly string[]): boolean | undefined {
    // Most vendors: the modality table has an API column whose rows read "<icon> Converse".
    const modalities = table(lines, 'Output Modalities');
    const apiColumn = modalities?.header.findIndex((h) => h.includes('APIs supported')) ?? -1;
    const listed = modalities?.rows.map((r) => r[apiColumn] ?? '').find((c) => /\)\s*Converse$/.test(c));
    if (listed) {
        return listed.includes('icon-yes.png');
    }
    // Claude layout: a separate table of API columns under this heading.
    const heading = lines.findIndex((l) => l.includes('APIs supported on `bedrock-runtime` endpoint'));
    const apis = heading >= 0 ? table(lines.slice(heading), 'Converse') : undefined;
    const cell = apis?.rows[0]?.[apis.header.indexOf('Converse')];
    return cell ? cell.includes('icon-yes.png') : undefined;
}

export function parseModelCard(card: string, markdown: string): ModelCard {
    const lines = markdown.split(/\r?\n/);
    const { pricing, longContextThreshold } = parseCardPricing(markdown);

    const modalities = table(lines, 'Output Modalities');
    const outputColumn = modalities?.header.indexOf('Output Modalities') ?? -1;
    const textOutput = modalities?.rows.some((r) => /icon-yes\.png\)\s*Text$/.test(r[outputColumn] ?? '')) ?? false;

    const access = table(lines, 'Model ID');
    const runtimeIds = new Set<string>();
    if (access) {
        const col = (name: string) => access.header.indexOf(name);
        for (const row of access.rows.filter((r) => r[0] === 'bedrock-runtime')) {
            ids(row[col('Model ID')], false).forEach((id) => runtimeIds.add(id));
            ids(row[col('Geo inference ID')], true).forEach((id) => runtimeIds.add(id));
            ids(row[col('Global inference ID')], true).forEach((id) => runtimeIds.add(id));
        }
    }

    return {
        card,
        runtimeIds: [...runtimeIds],
        contextWindow: detail(markdown, 'Context window'),
        maxOutputTokens: detail(markdown, 'Max output tokens'),
        textOutput,
        converse: converseSupport(lines),
        ...(pricing ? { pricing } : {}),
        ...(longContextThreshold !== undefined ? { longContextThreshold } : {}),
    };
}

const PRICE_CELL = /^\$(\d+(?:\.\d+)?)$/;

type CardRoute = 'geo' | 'global' | 'inRegion';
type RouteRows = Partial<Record<CardRoute, TokenPrice>>;

/** Row labels seen on 2026-10-04; Mantle rows are not bedrock-runtime prices and are skipped. */
function routeOf(label: string): CardRoute | undefined {
    if (/^Global CRIS\b/.test(label)) {
        return 'global';
    }
    if (/\b(Geo|US) CRIS\b/.test(label)) {
        return 'geo';
    }
    return /^In-Region$/.test(label) ? 'inRegion' : undefined;
}

/** Reads one price table; any unreadable cell fails the whole table so a partial price is never used. Cache columns are optional. */
function priceRows(lines: readonly string[]): RouteRows | undefined {
    const prices = table(lines, 'Inference option');
    if (!prices) {
        return undefined;
    }
    const col = (test: (h: string) => boolean) => prices.header.findIndex(test);
    const input = col((h) => h === 'Input');
    const output = col((h) => h === 'Output');
    const read = col((h) => /cache read/i.test(h));
    const write = col((h) => /cache write/i.test(h));
    if (input < 0 || output < 0) {
        return undefined;
    }
    const result: RouteRows = {};
    for (const row of prices.rows) {
        const route = routeOf(row[0]);
        if (!route) {
            continue;
        }
        // "—" marks a dimension the model does not offer (GPT-5.4 cache write, 2026-10-04).
        const cell = (i: number) => (i < 0 || row[i] === '—' ? null : PRICE_CELL.exec(row[i] ?? '')?.[1]);
        const values = [cell(input), cell(output), cell(read), cell(write)];
        if (values.includes(undefined)) {
            return undefined;
        }
        const [inputPerM, outputPerM, cacheReadPerM, cacheWritePerM] = values;
        result[route] = {
            inputPerM: Number(inputPerM),
            outputPerM: Number(outputPerM),
            ...(cacheReadPerM !== null ? { cacheReadPerM: Number(cacheReadPerM) } : {}),
            ...(cacheWritePerM !== null ? { cacheWritePerM: Number(cacheWritePerM) } : {}),
        };
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Reads the Standard commercial price tables from the Pricing section (layouts verified on 2026-10-04):
 * - GPT-5.6, GPT-6, GPT-6.1: headings name the tier, for example "Commercial Regions — short context (272K input tokens or fewer)";
 *   Ultrafast and GovCloud tables are skipped.
 * - Grok and Kimi: one table without tiers, followed by a GovCloud table, so only the first table is read.
 * Claude and gpt-oss cards link to the pricing page instead of listing prices, so they return nothing.
 */
export function parseCardPricing(markdown: string): { pricing?: RoutePrices; longContextThreshold?: number } {
    const start = markdown.search(/^## Pricing\b/m);
    if (start < 0) {
        return {};
    }
    const rest = markdown.slice(start + 1);
    const end = rest.search(/^## /m);
    const lines = (end < 0 ? rest : rest.slice(0, end)).split(/\r?\n/);
    const tiers: { short?: RouteRows; long?: RouteRows } = {};
    let threshold: number | undefined;
    let tiered = false;
    for (const [i, line] of lines.entries()) {
        const heading = /^#{3,4}\s+(.+)$/.exec(line)?.[1];
        if (!heading || !/Commercial Regions/.test(heading) || /Ultrafast/i.test(heading)) {
            continue;
        }
        tiered = true;
        const tier = /short context/i.test(heading) ? 'short' : /long context/i.test(heading) ? 'long' : undefined;
        const limit = /\((?:more than\s+)?([\d.,]+[KM]?)\s+input tokens/i.exec(heading)?.[1];
        const value = limit ? parseTokenCount(limit) : undefined;
        const rows = priceRows(lines.slice(i + 1));
        if (!tier || value === undefined || (threshold !== undefined && threshold !== value) || !rows || tiers[tier]) {
            return {};
        }
        threshold = value;
        tiers[tier] = rows;
    }
    if (!tiered) {
        tiers.short = priceRows(lines);
    }
    if (!tiers.short) {
        return {};
    }
    const price = (route: CardRoute): ModelPrice | undefined => {
        const short = tiers.short?.[route];
        const long = tiers.long?.[route];
        return short && (long ? { ...short, longContext: long } : short);
    };
    const pricing = Object.fromEntries((['geo', 'global', 'inRegion'] as const).flatMap((r) => (price(r) ? [[r, price(r)]] : []))) as RoutePrices;
    return { pricing, ...(tiers.long ? { longContextThreshold: threshold } : {}) };
}
