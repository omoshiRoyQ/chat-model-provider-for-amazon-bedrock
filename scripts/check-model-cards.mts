// Developer check: compares CATALOG in src/models.ts with the current AWS model cards and prints lines to paste into CATALOG.
// `pnpm run check-model-cards` only reads public AWS documentation. With `--profile <name> --region <region>`, it also
// probes the thinking format of models to add with small ConverseStream requests (billed). It never changes files.
import { parseArgs } from 'node:util';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { CATALOG, type ThinkingStyle } from '../src/models.ts';
import { MODEL_CARD_INDEX_URL, modelCardNames, modelCardUrl, parseModelCard, type ModelCard } from '../src/modelCards.ts';

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
const limits = (c: { contextWindow?: number; maxOutputTokens?: number }) => `context=${c.contextWindow ?? '未載明'}, maxOutput=${c.maxOutputTokens ?? '未載明'}`;
const entryLine = (id: string, e: { card: string; contextWindow?: number; maxOutputTokens?: number; thinking: string; nativeUnsupported?: true }) =>
    `'${id}': { card: '${e.card}'${e.contextWindow !== undefined ? `, contextWindow: ${e.contextWindow}` : ''}${e.maxOutputTokens !== undefined ? `, maxOutputTokens: ${e.maxOutputTokens}` : ''}, thinking: '${e.thinking}'${e.nativeUnsupported ? ', nativeUnsupported: true' : ''} },`;

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
                throw new Error(`不帶 thinking 參數也被拒，無法判斷（${(error as Error).message}）`);
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
    console.error(`無法讀取 model card 目錄：${(error as Error).message}`);
    process.exit(1);
}
if (names.length === 0) {
    console.error(`${MODEL_CARD_INDEX_URL} 裡找不到任何 model card，頁面格式可能已改變。`);
    process.exit(1);
}

const cards: ModelCard[] = [];
const failed: string[] = [];
const unparsed: string[] = [];
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
                    unparsed.push(`${name}：${label} 寫的是「${raw.trim()}」`);
                }
            }
        } catch (error) {
            failed.push(`${name}：${(error as Error).message}`);
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
for (const [id, entry] of catalog) {
    const card = cardByName.get(entry.card);
    if (!card) {
        continue;
    }
    const onRuntime = card.runtimeIds.includes(id);
    if (entry.nativeUnsupported && onRuntime) {
        nativeMismatch.push(`${id}：CATALOG 標示 nativeUnsupported，但 ${card.card} 已列出 bedrock-runtime`);
    } else if (!entry.nativeUnsupported && card.runtimeIds.length === 0) {
        nativeMismatch.push(`${id}：${card.card} 沒有列出 bedrock-runtime`);
    } else if (!entry.nativeUnsupported && !onRuntime) {
        idMismatch.push(`${id}：${card.card} 的 bedrock-runtime ID 是 ${card.runtimeIds.join('、')}`);
    }
    if (card.contextWindow !== entry.contextWindow || card.maxOutputTokens !== entry.maxOutputTokens) {
        limitMismatch.push(`${id}：CATALOG ${limits(entry)}；${card.card} ${limits(card)}\n      改成：${entryLine(id, { ...entry, contextWindow: card.contextWindow, maxOutputTokens: card.maxOutputTokens })}`);
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
        console.error(`無法列出 inference profile：${(error as Error).name}: ${(error as Error).message}\nSSO 過期時請先執行 aws sso login --profile ${probe.profile}`);
        process.exit(1);
    }
}
for (const card of toAdd) {
    for (const id of card.runtimeIds.filter(isClaudeOrGpt)) {
        if (!probe || !invokeIdOf) {
            additions.push(entryLine(id, { ...card, thinking: 'TODO' }));
            continue;
        }
        const invokeId = invokeIdOf(id);
        try {
            const { style, notes } = await probeThinking(probe.runtime, invokeId);
            additions.push(`// Verified ${date} with ConverseStream (${probe.region}, ${invokeId}): ${notes.join(', ')}\n      ${entryLine(id, { ...card, thinking: style })}`);
        } catch (error) {
            const e = error as { name?: string; message?: string };
            additions.push(`${id}：無法實測（${invokeId}，${e.name}: ${e.message}），請問使用者
      ${entryLine(id, { ...card, thinking: 'TODO' })}`);
        }
    }
}
probe?.runtime.destroy();

function section(title: string, lines: readonly string[]): void {
    console.log(`\n## ${title}（${lines.length}）`);
    console.log(lines.length > 0 ? lines.map((l) => `  - ${l}`).join('\n') : '  無');
}

console.log(`讀取 ${names.length} 個 model card，成功 ${cards.length} 個。`);
section(probe
    ? '可以加入 CATALOG 的 Claude／GPT 模型（已實測 thinking）'
    : '可以加入 CATALOG 的 Claude／GPT 模型（加上 --profile 與 --region 才會實測 thinking；TODO 會讓型別檢查失敗）', additions);
section('可以從 CATALOG 刪除（model card 已不在目錄中）', removable.map(([id, e]) => `${id}（${e.card}）`));
section('CATALOG 與 model card 的數字不同', limitMismatch);
section('CATALOG 的 model ID 不在 model card 的 bedrock-runtime ID 裡', idMismatch);
section('nativeUnsupported 與 model card 不一致', nativeMismatch);
section('頁面有寫數字但解析失敗（要更新 src/modelCards.ts）', unparsed);
section('下載失敗', failed);
console.log(`\n其他廠商有 ${otherVendors.length} 個文字模型有 bedrock-runtime ID；extension 執行時會自動讀取這些 model card，不需要加入 CATALOG。`);
