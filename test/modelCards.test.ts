import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ModelCardStore } from '../src/modelCardStore';
import { converseCacheModelIds, MODEL_CARD_INDEX_URL, modelCardNames, modelCardUrl, parseCardPricing, parseModelCard, parseTokenCount } from '../src/modelCards';

/**
 * Fixtures are excerpts of the markdown versions of AWS model cards and the user-guide index, fetched on 2026-10-01
 * from https://docs.aws.amazon.com/bedrock/latest/userguide/. Expected values are the figures printed on those pages.
 */

const YES = '![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png)';
const NO = '![not-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-no.png)';

// model-card-anthropic-claude-haiku-4-5: no bare runtime model ID, only geo and global profile IDs.
const HAIKU_45 = `
+ **Model lifecycle:** Active
+ **Context window:** 200K tokens
+ **Max output tokens:** 64K
+ **Reasoning:** Supported


| **Input Modalities** | **Output Modalities** | 
| --- | --- | 
| ${YES} Image | ${NO} Image | 
| ${YES} Text | ${YES} Text | 

**Endpoint support**


| **Endpoint** | **Supported** | 
| --- | --- | 
| bedrock-runtime | ${YES} | 
| bedrock-mantle | ${YES} | 

**APIs supported on \`bedrock-runtime\` endpoint**


| **Messages** | **Responses** | **Chat Completions** | **Converse** | **Invoke** | 
| --- | --- | --- | --- | --- | 
| ${YES} | ${NO} | ${NO} | ${YES} | ${YES} | 

**APIs supported on \`bedrock-mantle\` endpoint**


| **Messages** | **Responses** | **Chat Completions** | **Converse** | **Invoke** | 
| --- | --- | --- | --- | --- | 
| ${YES} | ${NO} | ${NO} | ${NO} | ${NO} | 

## Programmatic Access

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** | 
| --- | --- | --- | --- | --- | 
| bedrock-runtime | N/A | N/A | \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`<br />\`eu.anthropic.claude-haiku-4-5-20251001-v1:0\`<br />\`jp.anthropic.claude-haiku-4-5-20251001-v1:0\` | global.anthropic.claude-haiku-4-5-20251001-v1:0 | 
| bedrock-mantle | anthropic.claude-haiku-4-5 | https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages | N/A | N/A | 
`;

// model-card-openai-gpt-6-astra: bedrock-mantle row first, then bedrock-runtime; comma-separated figures.
const GPT_6_ASTRA = `
+ **Context window:** 1,050,000 tokens
+ **Max output tokens:** 128,000

| **Input Modalities** | **Output Modalities** | 
| --- | --- | 
| ${YES} Text | ${YES} Text | 

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** | 
| --- | --- | --- | --- | --- | 
| bedrock-mantle | openai.gpt-6-astra | \`https://bedrock-mantle.us-east-1.api.aws/openai/v1\`<br />\`https://bedrock-mantle.us-west-2.api.aws/openai/v1\` (Standard only) | Not supported | Not supported | 
| bedrock-runtime | openai.gpt-6-astra | Not supported | us.openai.gpt-6-astra | global.openai.gpt-6-astra | 
`;

// model-card-openai-gpt-54: bedrock-mantle only.
const GPT_54 = `
+ **Context window:** 1,050,000 tokens
+ **Max output tokens:** 128,000

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** | 
| --- | --- | --- | --- | --- | 
| bedrock-mantle | openai.gpt-5.4 | https://bedrock-mantle.{region}.api.aws/openai/v1 | Not supported | Not supported | 
`;

// model-card-meta-llama-3-3-70b-instruct: four-column modality table that also lists APIs and endpoints.
const LLAMA_33 = `
+ **Context window:** 128K tokens
+ **Max output tokens:** 4K

| **Input Modalities** | **Output Modalities** | **[APIs supported](apis.html)** | **[Endpoints supported](endpoints.html)** | 
| --- | --- | --- | --- | 
| ${NO} Audio | ${NO} Embedding | ${NO} Responses | ${YES} bedrock-runtime | 
| ${YES} Text | ${YES} Text | ${YES} Converse |  | 

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** | 
| --- | --- | --- | --- | --- | 
| bedrock-runtime | meta.llama3-3-70b-instruct-v1:0 | https://bedrock-runtime.{region}.amazonaws.com | us.meta.llama3-3-70b-instruct-v1:0 | Not supported | 
`;

// model-card-amazon-nova-2-sonic: speech model on bedrock-runtime without Converse.
const NOVA_2_SONIC = `
+ **Context window:** 1M tokens
+ **Max output tokens:** 64K

| **Input Modalities** | **Output Modalities** | **[APIs supported](apis.html)** | **[Endpoints supported](endpoints.html)** | 
| --- | --- | --- | --- | 
| ${NO} Audio | ${NO} Embedding | ${NO} Responses | ${YES} bedrock-runtime | 
| ${YES} Speech | ${YES} Speech | ${NO} Invoke |  | 
| ${YES} Text | ${YES} Text | ${NO} Converse |  | 
| ${NO} Video | ${NO} Video | ${YES} InvokeModelWithBidirectionalStream |  | 

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** | 
| --- | --- | --- | --- | --- | 
| bedrock-runtime | amazon.nova-2-sonic-v1:0 | https://bedrock-runtime.{region}.amazonaws.com | Not supported | Not supported | 
`;

// Excerpt of toc-contents.json, plus a name outside the accepted character set.
const INDEX = `{ "title" : "Anthropic", "href" : "model-cards-anthropic.html", "contents" : [ { "title" : "Claude Haiku 4.5", "href" : "model-card-anthropic-claude-haiku-4-5.html" }, { "title" : "Llama 3.3 70B Instruct", "href" : "model-card-meta-llama-3-3-70b-instruct.html" }, { "title" : "x", "href" : "model-card-../evil.html" } ] }`;

describe('parseTokenCount', () => {
    it.each([
        ['1M tokens', 1_000_000],
        ['10M tokens', 10_000_000],
        ['128K', 128_000],
        ['1,050,000 tokens', 1_050_000],
        ['131,072', 131_072],
        ['N/A', undefined],
    ])('%s', (text, expected) => {
        expect(parseTokenCount(text)).toBe(expected);
    });
});

describe('parseModelCard', () => {
    it('Claude layout: IDs come from geo and global columns with the prefix removed; mantle IDs are ignored', () => {
        expect(parseModelCard('model-card-anthropic-claude-haiku-4-5', HAIKU_45)).toEqual({
            card: 'model-card-anthropic-claude-haiku-4-5',
            runtimeIds: ['anthropic.claude-haiku-4-5-20251001-v1:0'],
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
            textOutput: true,
            converse: true,
        });
    });

    it('reads the bedrock-runtime row even when it is not the first row', () => {
        expect(parseModelCard('model-card-openai-gpt-6-astra', GPT_6_ASTRA)).toMatchObject({
            runtimeIds: ['openai.gpt-6-astra'],
            contextWindow: 1_050_000,
            maxOutputTokens: 128_000,
        });
    });

    it('a mantle-only card has no runtime IDs', () => {
        expect(parseModelCard('model-card-openai-gpt-54', GPT_54).runtimeIds).toEqual([]);
    });

    it('four-column modality table: text output is read from the output column', () => {
        expect(parseModelCard('model-card-meta-llama-3-3-70b-instruct', LLAMA_33)).toEqual({
            card: 'model-card-meta-llama-3-3-70b-instruct',
            runtimeIds: ['meta.llama3-3-70b-instruct-v1:0'],
            contextWindow: 128_000,
            maxOutputTokens: 4_000,
            textOutput: true,
            converse: true,
        });
    });

    it('reads a missing Converse API from the modality table', () => {
        expect(parseModelCard('model-card-amazon-nova-2-sonic', NOVA_2_SONIC)).toMatchObject({
            runtimeIds: ['amazon.nova-2-sonic-v1:0'],
            converse: false,
        });
    });

    it('missing fields stay undefined', () => {
        expect(parseModelCard('model-card-x', 'no tables here')).toEqual({ card: 'model-card-x', runtimeIds: [], contextWindow: undefined, maxOutputTokens: undefined, textOutput: false });
    });
});

/** Pricing sections copied from the markdown model cards fetched on 2026-10-04; expected values are the printed prices. */
const ASTRA_PRICING = `
## Pricing
<a name="model-card-openai-gpt-6-astra-pricing"></a>

All prices are in USD per 1 million tokens. The following tables list Standard and Ultrafast prices.

### Standard — Commercial Regions, short context (272K input tokens or fewer)
<a name="model-card-openai-gpt-6-astra-pricing-commercial-short"></a>


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region | $11.00 | $13.75 | $1.10 | $55.00 | 
| Geo CRIS | $11.00 | $13.75 | $1.10 | $55.00 | 
| Global CRIS | $10.00 | $12.50 | $1.00 | $50.00 | 

### Standard — Commercial Regions, long context (more than 272K input tokens)
<a name="model-card-openai-gpt-6-astra-pricing-commercial-long"></a>


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region | $22.00 | $27.50 | $2.20 | $82.50 | 
| Geo CRIS | $22.00 | $27.50 | $2.20 | $82.50 | 
| Global CRIS | $20.00 | $25.00 | $2.00 | $75.00 | 

### Ultrafast — Commercial Regions, short context (272K input tokens or fewer)
<a name="model-card-openai-gpt-6-astra-pricing-ultrafast-short"></a>


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region (us-east-1) | $66.00 | $82.50 | $6.60 | $330.00 | 
| Geo CRIS (US) | $66.00 | $82.50 | $6.60 | $330.00 | 
| Global CRIS | $60.00 | $75.00 | $6.00 | $300.00 | 

## Programmatic Access
`;

const SOL_61_PRICING = `
## Pricing

Long-context rates apply to the full request when input exceeds 272,000 tokens.

### Commercial Regions — short context (272K input tokens or fewer)


| **Inference option** | **Input** | **Input — cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| Regional (Mantle in IAD) | $2.20 | $2.75 | $0.11 | $11.00 | 
| US CRIS (bedrock-runtime) | $2.20 | $2.75 | $0.11 | $11.00 | 
| Global CRIS (bedrock-runtime) | $2.00 | $2.50 | $0.10 | $10.00 | 

### Commercial Regions — long context (more than 272K input tokens)


| **Inference option** | **Input** | **Input — cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| Regional (Mantle in IAD) | $4.40 | $5.50 | $0.22 | $16.50 | 
| US CRIS (bedrock-runtime) | $4.40 | $5.50 | $0.22 | $16.50 | 
| Global CRIS (bedrock-runtime) | $4.00 | $5.00 | $0.20 | $15.00 | 
`;

const LUNA_56_PRICING = `
## Pricing

### Commercial Regions — short context (272K input tokens or fewer)


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region | $0.22 | $0.275 | $0.022 | $1.32 | 
| Geo CRIS | $0.22 | $0.275 | $0.022 | $1.32 | 
| Global CRIS | $0.20 | $0.25 | $0.02 | $1.20 | 

### Commercial Regions — long context (more than 272K input tokens)


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region | $0.44 | $0.55 | $0.044 | $1.98 | 
| Geo CRIS | $0.44 | $0.55 | $0.044 | $1.98 | 
| Global CRIS | $0.40 | $0.50 | $0.04 | $1.80 | 

### AWS GovCloud (US-East and US-West)

#### Short context (272K input tokens or fewer)


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region | $0.27 | $0.3375 | $0.027 | $1.62 | 
`;

const CLAUDE_PRICING = `
## Pricing

This model is a third-party model offered and billed through AWS Marketplace. For pricing, see the [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/) page.
`;

const KIMI_K3_PRICING = `
## Pricing
<a name="model-card-moonshot-ai-kimi-k3-pricing"></a>


| **Inference option** | **Input** | **Output** | **Cache read** | **Cache write (30 min)** | 
| --- | --- | --- | --- | --- | 
| Global CRIS | $3.00 | $15.00 | $0.30 | $3.75 | 
| US CRIS | $3.30 | $16.50 | $0.33 | $4.125 | 

*All prices are per 1 million tokens. Pricing shown is for the Standard tier.*
`;

const GROK_43_PRICING = `
## Pricing
<a name="model-card-xai-grok-4-3-pricing"></a>


| **Inference option** | **Input** | **Output** | **Cache read** | 
| --- | --- | --- | --- | 
| In-Region | $1.25 | $2.50 | $0.20 | 

**AWS GovCloud (US-West)**


| **Inference option** | **Input** | **Output** | **Cache read** | 
| --- | --- | --- | --- | 
| In-Region | $1.50 | $3.00 | $0.24 | 
`;

describe('parseCardPricing', () => {
    it('GPT-6 Astra: Standard short and long tiers, Ultrafast skipped', () => {
        const geo = { inputPerM: 11, outputPerM: 55, cacheReadPerM: 1.1, cacheWritePerM: 13.75, longContext: { inputPerM: 22, outputPerM: 82.5, cacheReadPerM: 2.2, cacheWritePerM: 27.5 } };
        expect(parseCardPricing(ASTRA_PRICING)).toEqual({
            longContextThreshold: 272_000,
            pricing: {
                geo,
                global: { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5, longContext: { inputPerM: 20, outputPerM: 75, cacheReadPerM: 2, cacheWritePerM: 25 } },
                inRegion: geo,
            },
        });
    });

    it('Kimi K3: one table without tiers, "US CRIS" is Geo, 30-minute cache write column', () => {
        expect(parseCardPricing(KIMI_K3_PRICING)).toEqual({
            pricing: {
                geo: { inputPerM: 3.3, outputPerM: 16.5, cacheReadPerM: 0.33, cacheWritePerM: 4.125 },
                global: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
            },
        });
    });

    it('Grok 4.3: In-Region only, no cache write column, GovCloud table after it is skipped', () => {
        expect(parseCardPricing(GROK_43_PRICING)).toEqual({ pricing: { inRegion: { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 } } });
    });

    it('GPT-5.4: "—" means the cache write price is not offered', () => {
        const gpt54 = `
## Pricing

### Commercial Regions — short context (272K input tokens or fewer)


| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** | 
| --- | --- | --- | --- | --- | 
| In-Region | $2.75 | — | $0.275 | $16.50 | 
`;
        expect(parseCardPricing(gpt54).pricing?.inRegion).toEqual({ inputPerM: 2.75, outputPerM: 16.5, cacheReadPerM: 0.275 });
    });

    it('GPT-6.1 Sol: "US CRIS (bedrock-runtime)" is the Geo row; the Mantle row is skipped', () => {
        expect(parseCardPricing(SOL_61_PRICING).pricing?.geo).toEqual({
            inputPerM: 2.2, outputPerM: 11, cacheReadPerM: 0.11, cacheWritePerM: 2.75,
            longContext: { inputPerM: 4.4, outputPerM: 16.5, cacheReadPerM: 0.22, cacheWritePerM: 5.5 },
        });
    });

    it('GPT-5.6 Luna: GovCloud tables are skipped', () => {
        expect(parseCardPricing(LUNA_56_PRICING).pricing?.geo).toMatchObject({ inputPerM: 0.22, outputPerM: 1.32 });
    });

    it('Claude cards link to the pricing page and have no prices', () => {
        expect(parseCardPricing(CLAUDE_PRICING)).toEqual({});
    });

    it('an unreadable price cell drops the whole card price instead of using part of it', () => {
        expect(parseCardPricing(SOL_61_PRICING.replace('| $2.00 |', '| TBD |'))).toEqual({});
    });

    it('parseModelCard includes the pricing fields', () => {
        expect(parseModelCard('model-card-openai-gpt-6-astra', GPT_6_ASTRA + ASTRA_PRICING)).toMatchObject({ longContextThreshold: 272_000, pricing: { global: { inputPerM: 10 } } });
    });
});

describe('modelCardNames', () => {
    it('lists only model-card pages with safe names', () => {
        expect(modelCardNames(INDEX)).toEqual(['model-card-anthropic-claude-haiku-4-5', 'model-card-meta-llama-3-3-70b-instruct']);
    });
});

/** Excerpt of prompt-caching.md fetched on 2026-10-04. */
const PROMPT_CACHING = `
## Supported models, Regions, and explicit caching limits

| Model name | Model ID | Release Type | Minimum number of tokens per cache checkpoint | Maximum number of cache checkpoints per request | Supported TTL | Fields that accept prompt cache checkpoints | 
| --- | --- | --- | --- | --- | --- | --- | 
| Claude Sonnet 5.5 | anthropic.claude-sonnet-5-5 | Generally Available | 512 | 4 | 5 minutes, 1 hour | \`system\`, \`messages\`, and \`tools\` | 
| Claude Haiku 4.5 | anthropic.claude-haiku-4-5-20251001-v1:0 | Generally Available | 4,096 | 4 | 5 minutes, 1 hour | \`system\`, \`messages\`, and \`tools\` | 
| GPT-5.6 Sol | openai.gpt-5.6-sol | Generally Available | 1,024 | 4 | 30 minutes | \`prompt_cache_breakpoint\` on \`input_text\`, \`input_image\`, and \`input_file\` blocks (Responses API) | 

To use the 1-hour TTL option ...
`;

describe('converseCacheModelIds', () => {
    it('lists models whose checkpoints are accepted in Converse messages; Responses-only GPT rows are skipped', () => {
        expect(converseCacheModelIds(PROMPT_CACHING)).toEqual(['anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-4-5-20251001-v1:0']);
    });

    it('returns undefined when the table is missing', () => {
        expect(converseCacheModelIds('no table')).toBeUndefined();
    });
});

describe('ModelCardStore', () => {
    const memento = () => {
        const data = new Map<string, unknown>();
        return {
            get: (key: string) => data.get(key),
            update: async (key: string, value: unknown) => {
                data.set(key, value);
            },
        } as unknown as vscode.Memento;
    };
    const pages: Record<string, string> = {
        [MODEL_CARD_INDEX_URL]: INDEX,
        [modelCardUrl('model-card-anthropic-claude-haiku-4-5')]: HAIKU_45,
        [modelCardUrl('model-card-meta-llama-3-3-70b-instruct')]: LLAMA_33,
    };
    const stubFetch = (failing: string[] = []) => {
        const fetchMock = vi.fn(async (url: string) => {
            const body = failing.includes(url) ? undefined : pages[url];
            return body === undefined
                ? { ok: false, status: 404, statusText: 'Not Found', text: async () => '' }
                : { ok: true, status: 200, statusText: 'OK', text: async () => body };
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    };
    const LLAMA = 'meta.llama3-3-70b-instruct-v1:0';

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches the index and cards, then answers from the cache', async () => {
        const fetchMock = stubFetch();
        const store = new ModelCardStore(memento());
        expect(store.limits().size).toBe(0);
        expect(store.needsRefresh([LLAMA], 0)).toBe(true);

        await expect(store.refresh([LLAMA], 1_000)).resolves.toEqual({ fetched: 2, failed: [] });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(store.limits().get(LLAMA)).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 4_000 });
        expect(store.needsRefresh([LLAMA], 2_000)).toBe(false);
        expect(store.needsRefresh([LLAMA, 'vendor.new-model'], 2_000)).toBe(true);

        fetchMock.mockClear();
        await store.refresh([LLAMA, 'vendor.new-model'], 3_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a failed page is retried on the next model-list load', async () => {
        stubFetch([modelCardUrl('model-card-meta-llama-3-3-70b-instruct')]);
        const store = new ModelCardStore(memento());
        const result = await store.refresh([LLAMA], 1_000);
        expect(result.failed).toEqual(['model-card-meta-llama-3-3-70b-instruct']);
        expect(store.limits().has(LLAMA)).toBe(false);
        expect(store.needsRefresh([LLAMA], 2_000)).toBe(true);
    });

    it('throws when the index cannot be read', async () => {
        stubFetch([MODEL_CARD_INDEX_URL]);
        await expect(new ModelCardStore(memento()).refresh([LLAMA], 1_000)).rejects.toThrow('HTTP 404');
    });

    // User decision (2026-10-04): a page that fails keeps its last good copy; a card removed from the index is dropped.
    it('keeps the previous copy of a page that fails, but drops cards no longer in the index', async () => {
        const cards = new ModelCardStore(memento());
        stubFetch();
        await cards.refresh([LLAMA], 1_000);

        stubFetch([modelCardUrl('model-card-meta-llama-3-3-70b-instruct')]);
        await expect(cards.refresh([], 2_000, true)).resolves.toMatchObject({ failed: ['model-card-meta-llama-3-3-70b-instruct'] });
        expect(cards.limits().get(LLAMA)).toMatchObject({ contextWindow: 128_000 });

        const index = pages[MODEL_CARD_INDEX_URL];
        pages[MODEL_CARD_INDEX_URL] = index.replace('model-card-meta-llama-3-3-70b-instruct.html', 'removed.html');
        try {
            stubFetch();
            await cards.refresh([], 3_000, true);
            expect(cards.limits().has(LLAMA)).toBe(false);
        } finally {
            pages[MODEL_CARD_INDEX_URL] = index;
        }
    });

    it('ignores a cache written before pricing was parsed, and force downloads every card again', async () => {
        const store = memento();
        await store.update('modelCardCache', { checkedAt: 1_000, searched: [LLAMA], cards: { x: { card: 'x', runtimeIds: [LLAMA], textOutput: true } } });
        const cards = new ModelCardStore(store);
        expect(cards.limits().size).toBe(0);
        expect(cards.needsRefresh([LLAMA], 2_000)).toBe(true);

        const fetchMock = stubFetch();
        await cards.refresh([LLAMA], 2_000);
        fetchMock.mockClear();
        await expect(cards.refresh([], 3_000, true)).resolves.toEqual({ fetched: 2, failed: [] });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(cards.needsRefresh([LLAMA], 4_000)).toBe(false);
    });
});
