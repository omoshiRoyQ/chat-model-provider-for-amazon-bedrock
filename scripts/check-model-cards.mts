// Developer check: compares CATALOG in src/models.ts with the current AWS model cards and prints lines to paste into CATALOG.
// `pnpm run check-model-cards` only reads public AWS documentation. With `--profile <name> --region <region>`, it also
// probes the thinking format of models to add with small ConverseStream requests (billed). It never changes files.
import { parseArgs } from 'node:util';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { CATALOG, type ThinkingStyle } from '../src/models.ts';
import { converseCacheModelIds, MODEL_CARD_INDEX_URL, modelCardNames, modelCardUrl, parseModelCard, PROMPT_CACHING_URL, type ModelCard } from '../src/modelCards.ts';

const CONCURRENCY = 6;
const { values: args } = parseArgs({ options: { profile: { type: 'string' }, region: { type: 'string' } } });

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} (${url})`);
    }
    return response.text();
}

const isClaudeOrGpt = (id: string) => id.startsWith('anthropic.') || id.startsWith('openai.');
const limits = (c: { contextWindow?: number; maxOutputTokens?: number; longContextThreshold?: number }) =>
    `context=${c.contextWindow ?? 'unspecified'}, maxOutput=${c.maxOutputTokens ?? 'unspecified'}, longContextThreshold=${c.longContextThreshold ?? 'none'}`;
const entryLine = (id: string, e: { card: string; contextWindow?: number; maxOutputTokens?: number; thinking: string; nativeUnsupported?: true; promptCache?: true; longContextThreshold?: number }) =>
    `'${id}': { card: '${e.card}'${e.contextWindow !== undefined ? `, contextWindow: ${e.contextWindow}` : ''}${e.maxOutputTokens !== undefined ? `, maxOutputTokens: ${e.maxOutputTokens}` : ''}, thinking: '${e.thinking}'${e.nativeUnsupported ? ', nativeUnsupported: true' : ''}${e.promptCache ? ', promptCache: true' : ''}${e.longContextThreshold !== undefined ? `, longContextThreshold: ${e.longContextThreshold}` : ''} },`;

/** Profile IDs are `<route>.<model ID>`; prefer a geo profile, then global, then the bare ID for on-demand models. */
async function invokeIds(profile: string, region: string): Promise<(baseId: string) => string> {
    const client = new BedrockClient({ region, credentials: fromIni({ profile }) });
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
        const page = await client.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken }));
        ids.push(...(page.inferenceProfileSummaries ?? []).flatMap((p) => (p.status === 'ACTIVE' && p.inferenceProfileId ? [p.inferenceProfileId] : [])));
        nextToken = page.nextToken;
    } while (nextToken);
    client.destroy();
    return (baseId) => {
        const matches = ids.filter((id) => id.slice(id.indexOf('.') + 1) === baseId);
        return matches.find((id) => !id.startsWith('global.')) ?? matches[0] ?? baseId;
    };
}

/** Mirrors the formats verified in src/thinking.ts; a ValidationException means the parameters were rejected. */
async function probeThinking(runtime: BedrockRuntimeClient, modelId: string): Promise<{ style: ThinkingStyle; notes: string[] }> {
    const notes: string[] = [];
    const accepts = async (label: string, fields?: ConverseStreamCommandInput['additionalModelRequestFields']) => {
        try {
            const response = await runtime.send(new ConverseStreamCommand({
                modelId,
                messages: [{ role: 'user', content: [{ text: 'Reply with OK.' }] }],
                // Extended thinking needs maxTokens above budget_tokens (1024).
                inferenceConfig: { maxTokens: fields ? 1_100 : 16 },
                additionalModelRequestFields: fields,
            }));
            for await (const _event of response.stream ?? []) {
                // Drain the stream so errors raised mid-stream are caught.
            }
            notes.push(`${label}=ok`);
            return true;
        } catch (error) {
            if ((error as { name?: string }).name !== 'ValidationException') {
                throw error;
            }
            notes.push(`${label}=ValidationException`);
            if (!fields) {
                throw new Error(`Rejected even without thinking parameters, so the format cannot be determined (${(error as Error).message})`);
            }
            return false;
        }
    };
    await accepts('baseline');
    if (modelId.includes('anthropic.')) {
        if (await accepts('adaptive', { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } })) {
            return { style: (await accepts('disabled', { thinking: { type: 'disabled' } })) ? 'adaptive' : 'adaptiveAlways', notes };
        }
        return { style: (await accepts('extended', { thinking: { type: 'enabled', budget_tokens: 1_024 } })) ? 'extended' : 'none', notes };
    }
    if (!(await accepts('effort=low', { reasoning: { effort: 'low' } }))) {
        return { style: 'none', notes };
    }
    return { style: (await accepts('effort=none', { reasoning: { effort: 'none' } })) ? 'openai' : 'openaiNoNone', notes };
}

let names: string[];
try {
    names = modelCardNames(await fetchText(MODEL_CARD_INDEX_URL));
} catch (error) {
    console.error(`Cannot read the model card index: ${(error as Error).message}`);
    process.exit(1);
}
if (names.length === 0) {
    console.error(`No model cards found in ${MODEL_CARD_INDEX_URL}; the page format may have changed.`);
    process.exit(1);
}

const cards: ModelCard[] = [];
const failed: string[] = [];
const unparsed: string[] = [];
let cacheIds: Set<string> | undefined;
try {
    const ids = converseCacheModelIds(await fetchText(PROMPT_CACHING_URL));
    if (ids) {
        cacheIds = new Set(ids);
    } else {
        unparsed.push(`${PROMPT_CACHING_URL}: model table for explicit prompt caching not found`);
    }
} catch (error) {
    failed.push(`${PROMPT_CACHING_URL}: ${(error as Error).message}`);
}
const promptCacheOf = (id: string) => (cacheIds?.has(id) ? (true as const) : undefined);
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < names.length) {
        const name = names[next++];
        try {
            const markdown = await fetchText(modelCardUrl(name));
            const card = parseModelCard(name, markdown);
            cards.push(card);
            for (const [label, value] of [['Context window', card.contextWindow], ['Max output tokens', card.maxOutputTokens]] as const) {
                const raw = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`).exec(markdown)?.[1];
                if (raw !== undefined && value === undefined) {
                    unparsed.push(`${name}: ${label} is "${raw.trim()}"`);
                }
            }
            if (!card.pricing && /^## Pricing[\s\S]*\| \$\d/m.test(markdown)) {
                unparsed.push(`${name}: the Pricing section has a price table that failed to parse`);
            }
        } catch (error) {
            failed.push(`${name}: ${(error as Error).message}`);
        }
    }
}));
cards.sort((a, b) => a.card.localeCompare(b.card));
const cardByName = new Map(cards.map((c) => [c.card, c]));
const catalog = Object.entries(CATALOG);

const toAdd = cards.filter((c) => c.textOutput && c.runtimeIds.some(isClaudeOrGpt) && !c.runtimeIds.some((id) => CATALOG[id]));
const removable = catalog.filter(([, e]) => !names.includes(e.card));
const idMismatch: string[] = [];
const limitMismatch: string[] = [];
const nativeMismatch: string[] = [];
const cacheMismatch: string[] = [];
for (const [id, entry] of catalog) {
    if (cacheIds && !!entry.promptCache !== cacheIds.has(id)) {
        cacheMismatch.push(`${id}: CATALOG promptCache=${entry.promptCache ?? false}; the prompt-caching page ${cacheIds.has(id) ? 'lists' : 'does not list'} it as supporting Converse cache points\n      Change to: ${entryLine(id, { ...entry, promptCache: promptCacheOf(id) })}`);
    }
    const card = cardByName.get(entry.card);
    if (!card) {
        continue;
    }
    const onRuntime = card.runtimeIds.includes(id);
    if (entry.nativeUnsupported && onRuntime) {
        nativeMismatch.push(`${id}: CATALOG marks nativeUnsupported, but ${card.card} lists bedrock-runtime`);
    } else if (!entry.nativeUnsupported && card.runtimeIds.length === 0) {
        nativeMismatch.push(`${id}: ${card.card} does not list bedrock-runtime`);
    } else if (!entry.nativeUnsupported && !onRuntime) {
        idMismatch.push(`${id}: the bedrock-runtime IDs of ${card.card} are ${card.runtimeIds.join(', ')}`);
    }
    // A card without a threshold is not a mismatch: Haiku 5.5's 100K comes from Anthropic's pricing page (see pricing.instructions.md).
    const threshold = card.longContextThreshold ?? entry.longContextThreshold;
    if (card.contextWindow !== entry.contextWindow || card.maxOutputTokens !== entry.maxOutputTokens || threshold !== entry.longContextThreshold) {
        limitMismatch.push(`${id}: CATALOG ${limits(entry)}; ${card.card} ${limits(card)}\n      Change to: ${entryLine(id, { ...entry, contextWindow: card.contextWindow, maxOutputTokens: card.maxOutputTokens, longContextThreshold: threshold })}`);
    }
}
const otherVendors = cards.filter((c) => c.textOutput && c.runtimeIds.length > 0 && !c.runtimeIds.some(isClaudeOrGpt));

const additions: string[] = [];
// sv-SE formats the local date as YYYY-MM-DD.
const date = new Date().toLocaleDateString('sv-SE');
const probe = args.profile && args.region
    ? { profile: args.profile, region: args.region, runtime: new BedrockRuntimeClient({ region: args.region, credentials: fromIni({ profile: args.profile }) }) }
    : undefined;
let invokeIdOf: ((baseId: string) => string) | undefined;
if (probe && toAdd.length > 0) {
    try {
        invokeIdOf = await invokeIds(probe.profile, probe.region);
    } catch (error) {
        console.error(`Cannot list inference profiles: ${(error as Error).name}: ${(error as Error).message}\nIf SSO has expired, run aws sso login --profile ${probe.profile}`);
        process.exit(1);
    }
}
for (const card of toAdd) {
    for (const id of card.runtimeIds.filter(isClaudeOrGpt)) {
        if (!probe || !invokeIdOf) {
            additions.push(entryLine(id, { ...card, thinking: 'TODO', promptCache: promptCacheOf(id) }));
            continue;
        }
        const invokeId = invokeIdOf(id);
        try {
            const { style, notes } = await probeThinking(probe.runtime, invokeId);
            additions.push(`// Verified ${date} with ConverseStream (${probe.region}, ${invokeId}): ${notes.join(', ')}\n      ${entryLine(id, { ...card, thinking: style, promptCache: promptCacheOf(id) })}`);
        } catch (error) {
            const e = error as { name?: string; message?: string };
            additions.push(`${id}: cannot probe (${invokeId}, ${e.name}: ${e.message}); ask the user
      ${entryLine(id, { ...card, thinking: 'TODO', promptCache: promptCacheOf(id) })}`);
        }
    }
}
probe?.runtime.destroy();

function section(title: string, lines: readonly string[]): void {
    console.log(`\n## ${title} (${lines.length})`);
    console.log(lines.length > 0 ? lines.map((l) => `  - ${l}`).join('\n') : '  none');
}

console.log(`Read ${names.length} model cards, ${cards.length} succeeded.`);
section(probe
    ? 'Claude/GPT models to add to CATALOG (thinking probed)'
    : 'Claude/GPT models to add to CATALOG (add --profile and --region to probe thinking; TODO fails type checking)', additions);
section('Removable from CATALOG (model card no longer listed)', removable.map(([id, e]) => `${id} (${e.card})`));
section('CATALOG and model card numbers differ', limitMismatch);
section('CATALOG model ID is not among the model card bedrock-runtime IDs', idMismatch);
section('nativeUnsupported disagrees with the model card', nativeMismatch);
section('promptCache disagrees with the prompt-caching page', cacheMismatch);
section('Numbers present but unparsed (update src/modelCards.ts)', unparsed);
section('Download failed', failed);
console.log(`\n${otherVendors.length} text models from other vendors have bedrock-runtime IDs; the extension reads these model cards at runtime, so they do not need to be added to CATALOG.`);
