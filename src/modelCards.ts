/**
 * Parses AWS Bedrock model-card pages (public documentation; pure functions, no network access).
 * The pages are written for people, not as an API, so every field is optional and parse failures leave it undefined.
 * Page layout verified on 2026-10-01 against the markdown versions of the Claude, GPT, and Llama model cards.
 */

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
    };
}
