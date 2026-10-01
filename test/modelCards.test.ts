import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ModelCardStore } from '../src/modelCardStore';
import { MODEL_CARD_INDEX_URL, modelCardNames, modelCardUrl, parseModelCard, parseTokenCount } from '../src/modelCards';

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

describe('modelCardNames', () => {
    it('lists only model-card pages with safe names', () => {
        expect(modelCardNames(INDEX)).toEqual(['model-card-anthropic-claude-haiku-4-5', 'model-card-meta-llama-3-3-70b-instruct']);
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
});
