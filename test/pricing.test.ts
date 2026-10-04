import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { PriceStore } from '../src/priceStore';
import { estimateCost, estimateModelCost, lookupPrice, parseOffer, priceUrl, type PriceTable } from '../src/pricing';
import { buildUsageView } from '../src/usageView';
import { readCustomPricing } from '../src/settings';

/**
 * Expected values come from the AWS public price file AmazonBedrockFoundationModels/current/us-west-2/index.json
 * (publicationDate 2026-09-25T09:39:35Z); test data is a reduced sample using its field format.
 */

function product(sku: string, servicename: string, usagetype: string, usd: string, unit = '1M tokens') {
    return {
        product: [sku, { attributes: { servicename, usagetype } }] as const,
        term: [sku, { t: { priceDimensions: { d: { unit, pricePerUnit: { USD: usd } } } } }] as const,
    };
}

const items = [
    // Current naming (Opus 5.5).
    product('a1', 'Claude Opus 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_input_tokens_standard-Units', '4.4000000000'),
    product('a2', 'Claude Opus 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_output_tokens_standard-Units', '22.0000000000'),
    product('a3', 'Claude Opus 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_input_tokens_global_standard-Units', '4.0000000000'),
    product('a4', 'Claude Opus 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_output_tokens_global_standard-Units', '20.0000000000'),
    // Legacy naming (Haiku 4.5).
    product('b1', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount-Units', '1.1000000000'),
    product('b2', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_OutputTokenCount-Units', '5.5000000000'),
    product('b3', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount_Global-Units', '1.0000000000'),
    product('b4', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_OutputTokenCount_Global-Units', '5.0000000000'),
    // Only one price is listed (Opus 4.1).
    product('c1', 'Claude Opus 4.1 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount-Units', '15.0000000000'),
    product('c2', 'Claude Opus 4.1 (Amazon Bedrock Edition)', 'USW2-MP:USW2_OutputTokenCount-Units', '75.0000000000'),
    // Should be skipped: batch, cache without token prices, hourly pricing, and models with input-only prices.
    product('d1', 'Claude Opus 4.1 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount_Batch-Units', '7.5'),
    product('d2', 'Claude Fable 5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_read_tokens_standard-Units', '1.1'),
    product('d3', 'Claude 3.7 Sonnet (Amazon Bedrock Edition)', 'USW2-MP:USW2_ProvisionedThroughput_1MonthCommit_ModelUnits_Usage-Units', '158.4', 'hour'),
    product('d4', 'Claude Instant (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount-Units', '0.8'),
];

/** Prompt-cache rows from the us-west-2 price file, publicationDate 2026-09-30T00:19:12Z (downloaded 2026-10-03). */
const cacheItems = [
    // Current naming (Sonnet 5.5); 1h cache writes must be skipped.
    product('s1', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_input_tokens_standard-Units', '2.2000000000'),
    product('s2', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_output_tokens_standard-Units', '11.0000000000'),
    product('s3', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_input_tokens_global_standard-Units', '2.0000000000'),
    product('s4', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_output_tokens_global_standard-Units', '10.0000000000'),
    product('s5', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_read_tokens_standard-Units', '0.2200000000'),
    product('s6', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_read_tokens_global_standard-Units', '0.2000000000'),
    product('s7', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_write_tokens_standard-Units', '2.7500000000'),
    product('s8', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_write_tokens_global_standard-Units', '2.5000000000'),
    product('s9', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_write_tokens_1h_standard-Units', '4.4000000000'),
    product('s10', 'Claude Sonnet 5.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_write_tokens_1h_global_standard-Units', '4.0000000000'),
    // Legacy naming (Haiku 4.5); 1h cache writes must be skipped.
    product('h1', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount-Units', '1.1000000000'),
    product('h2', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_OutputTokenCount-Units', '5.5000000000'),
    product('h3', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount_Global-Units', '1.0000000000'),
    product('h4', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_OutputTokenCount_Global-Units', '5.0000000000'),
    product('h5', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_CacheReadInputTokenCount-Units', '0.1100000000'),
    product('h6', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_CacheReadInputTokenCount_Global-Units', '0.1000000000'),
    product('h7', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_CacheWriteInputTokenCount-Units', '1.3750000000'),
    product('h8', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_CacheWriteInputTokenCount_Global-Units', '1.2500000000'),
    product('h9', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_CacheWrite1hInputTokenCount-Units', '2.2000000000'),
    product('h10', 'Claude Haiku 4.5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_CacheWrite1hInputTokenCount_Global-Units', '2.0000000000'),
];
const cacheOffer = {
    publicationDate: '2026-09-30T00:19:12Z',
    products: Object.fromEntries(cacheItems.map((i) => i.product)),
    terms: { OnDemand: Object.fromEntries(cacheItems.map((i) => i.term)) },
};

/** GPT-6 Astra rows from the us-west-2 price file, publicationDate 2026-09-30T00:19:12Z (downloaded 2026-10-04). */
const astraItems = [
    ['input_tokens_standard', '11'], ['output_tokens_standard', '55'], ['cache_read_tokens_standard', '1.1'], ['cache_write_tokens_30m_standard', '13.75'],
    ['input_tokens_global_standard', '10'], ['output_tokens_global_standard', '50'], ['cache_read_tokens_global_standard', '1'], ['cache_write_tokens_30m_global_standard', '12.5'],
    ['input_tokens_long_ctx_standard', '22'], ['output_tokens_long_ctx_standard', '82.5'], ['cache_read_tokens_long_ctx_standard', '2.2'], ['cache_write_tokens_30m_long_ctx_standard', '27.5'],
    ['input_tokens_long_ctx_global_standard', '20'], ['output_tokens_long_ctx_global_standard', '75'], ['cache_read_tokens_long_ctx_global_standard', '2'], ['cache_write_tokens_30m_long_ctx_global_standard', '25'],
].map(([usage, usd], i) => product(`x${i}`, 'OpenAI GPT-6 Astra (Amazon Bedrock Edition)', `USW2-MP:USW2_${usage}-Units`, usd));
const astraOffer = {
    publicationDate: '2026-09-30T00:19:12Z',
    products: Object.fromEntries(astraItems.map((i) => i.product)),
    terms: { OnDemand: Object.fromEntries(astraItems.map((i) => i.term)) },
};
const NO_CARDS = new Map();
const offer = {
    publicationDate: '2026-09-25T09:39:35Z',
    products: Object.fromEntries(items.map((i) => i.product)),
    terms: { OnDemand: Object.fromEntries(items.map((i) => i.term)) },
};

// Prices taken from the same us-west-2 price file.
const TABLE: PriceTable = {
    region: 'us-west-2',
    publicationDate: '2026-09-25T09:39:35Z',
    source: 'test',
    models: {
        'Claude 3 Sonnet': { geo: { inputPerM: 3, outputPerM: 15 }, global: { inputPerM: 3, outputPerM: 15 } },
        'Claude Opus 5.5': { geo: { inputPerM: 4.4, outputPerM: 22 }, global: { inputPerM: 4, outputPerM: 20 } },
    },
};

describe('parseOffer', () => {
    const table = parseOffer(offer, 'us-west-2', 'test');

    it('解析新式與舊式兩種 usagetype 命名，分出 Geo 與 Global', () => {
        expect(table.models['Claude Opus 5.5']).toEqual({ geo: { inputPerM: 4.4, outputPerM: 22 }, global: { inputPerM: 4, outputPerM: 20 } });
        expect(table.models['Claude Haiku 4.5']).toEqual({ geo: { inputPerM: 1.1, outputPerM: 5.5 }, global: { inputPerM: 1, outputPerM: 5 } });
    });

    it('沒有 Global 分項的模型，Global 套用同一個價格', () => {
        expect(table.models['Claude Opus 4.1']).toEqual({ geo: { inputPerM: 15, outputPerM: 75 }, global: { inputPerM: 15, outputPerM: 75 } });
    });

    it('略過批次、每小時計價，以及缺輸入或輸出價的模型', () => {
        expect(Object.keys(table.models).sort()).toEqual(['Claude Haiku 4.5', 'Claude Opus 4.1', 'Claude Opus 5.5']);
        expect(table.publicationDate).toBe('2026-09-25T09:39:35Z');
    });

    it('解析新式與舊式的 5 分鐘快取單價，略過 1h 快取寫入', () => {
        const cached = parseOffer(cacheOffer, 'us-west-2', 'test');
        expect(cached.models['Claude Sonnet 5.5']).toEqual({
            geo: { inputPerM: 2.2, outputPerM: 11, cacheReadPerM: 0.22, cacheWritePerM: 2.75 },
            global: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
        });
        expect(cached.models['Claude Haiku 4.5']).toEqual({
            geo: { inputPerM: 1.1, outputPerM: 5.5, cacheReadPerM: 0.11, cacheWritePerM: 1.375 },
            global: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
        });
    });

    it('價格檔沒有快取單價時，不補上快取單價', () => {
        expect(table.models['Claude Opus 5.5'].geo).not.toHaveProperty('cacheReadPerM');
        expect(table.models['Claude Opus 5.5'].geo).not.toHaveProperty('cacheWritePerM');
    });

    it('GPT-6 Astra：30 分鐘快取寫入當作快取寫入單價，long_ctx 放進 longContext', () => {
        expect(parseOffer(astraOffer, 'us-west-2', 'test').models['OpenAI GPT-6 Astra']).toEqual({
            geo: {
                inputPerM: 11, outputPerM: 55, cacheReadPerM: 1.1, cacheWritePerM: 13.75,
                longContext: { inputPerM: 22, outputPerM: 82.5, cacheReadPerM: 2.2, cacheWritePerM: 27.5 },
            },
            global: {
                inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5,
                longContext: { inputPerM: 20, outputPerM: 75, cacheReadPerM: 2, cacheWritePerM: 25 },
            },
        });
    });
});

describe('priceUrl', () => {
    it('只接受 AWS region 格式', () => {
        expect(priceUrl('ap-northeast-1')).toContain('/current/ap-northeast-1/index.json');
        expect(priceUrl('us-west-2/../../x')).toBeUndefined();
        expect(priceUrl('')).toBeUndefined();
    });
});

describe('PriceStore', () => {
    // User decision (2026-09-30): no bundled price table; prices exist only after Update Prices.
    it('沒有下載過時，任何 region（含 us-west-2）都沒有價格表', () => {
        const memento = { get: () => undefined } as unknown as vscode.Memento;
        expect(new PriceStore(memento).get('us-west-2')).toBeUndefined();
    });
});

describe('lookupPrice / estimateCost', () => {
    it('Geo 與 Global 用不同單價；In-Region 套 Geo', () => {
        expect(lookupPrice(TABLE, {}, NO_CARDS, 'anthropic.claude-opus-5-5', 'Claude Opus 5.5', 'Global')?.price).toEqual({ inputPerM: 4, outputPerM: 20 });
        expect(lookupPrice(TABLE, {}, NO_CARDS, 'anthropic.claude-opus-5-5', 'Claude Opus 5.5', 'In-Region')?.price).toEqual({ inputPerM: 4.4, outputPerM: 22 });
    });

    it('自訂價格優先；價格表與 model card 都沒有的模型回傳 undefined', () => {
        const custom = { 'openai.gpt-6-astra': { inputPerM: 5, outputPerM: 20 } };
        expect(lookupPrice(TABLE, custom, NO_CARDS, 'openai.gpt-6-astra', 'GPT-6 Astra', 'Geo')).toEqual({ price: custom['openai.gpt-6-astra'], source: 'custom' });
        expect(lookupPrice(TABLE, {}, NO_CARDS, 'openai.gpt-6-astra', 'GPT-6 Astra', 'Geo')).toBeUndefined();
    });

    it('價格表沒有時改用 model card 價格；card 沒列的路由沒有價格', () => {
        // GPT-6 Sol Global short-context prices from model-card-openai-gpt-6-sol (fetched 2026-10-04).
        const global = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };
        const cards = new Map([['openai.gpt-6-sol', { pricing: { global } }]]);
        expect(lookupPrice(TABLE, {}, cards, 'openai.gpt-6-sol', 'GPT-6 Sol', 'Global')).toEqual({ price: global, source: 'modelCard' });
        expect(lookupPrice(TABLE, {}, cards, 'openai.gpt-6-sol', 'GPT-6 Sol', 'Geo')).toBeUndefined();
    });

    it('名稱帶「Anthropic 」前綴（找不到 foundation model 時）也能比對', () => {
        expect(lookupPrice(TABLE, {}, NO_CARDS, 'anthropic.claude-3-sonnet-20240229-v1:0', 'Anthropic Claude 3 Sonnet', 'Geo')?.price).toEqual({ inputPerM: 3, outputPerM: 15 });
    });

    it('1M 輸入、100K 輸出的費用', () => {
        expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 100_000 }, { inputPerM: 4.4, outputPerM: 22 })).toBeCloseTo(6.6, 10);
    });

    it('快取讀取與寫入分別計價（Sonnet 5.5 Global 單價）', () => {
        // Unit prices from the us-west-2 price file: input 2.0, output 10, cache read 0.2, cache write 2.5 USD per 1M tokens.
        const price = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };
        expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, price)).toBeCloseTo(4.7, 10);
    });

    it('有快取 token 但沒有快取單價時不估算；沒有快取 token 時照常估算', () => {
        // User decision (2026-10-03): GPT cache prices are not in the price file and must not be guessed.
        const price = { inputPerM: 5, outputPerM: 20 };
        expect(estimateCost({ inputTokens: 2, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 19_001 }, price)).toBeUndefined();
        expect(estimateCost({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }, { ...price, cacheWritePerM: 1 })).toBeUndefined();
        expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, price)).toBe(5);
    });
});

describe('estimateModelCost', () => {
    // GPT-6 Astra Global prices from its model card and the price file (2026-10-04). The card states that long-context
    // rates apply to the full request when input exceeds 272,000 tokens.
    const astra = {
        inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5,
        longContext: { inputPerM: 20, outputPerM: 75, cacheReadPerM: 2, cacheWritePerM: 25 },
    };

    it('long-context 請求的 token 整筆用長 context 單價，其餘用標準單價', () => {
        const usage = {
            inputTokens: 400_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0,
            longContext: { inputTokens: 300_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
        };
        // Standard: 100K × 10 + 1K × 50 = 1.05; long: 300K × 20 + 1K × 75 = 6.075 (USD per 1M tokens).
        const result = estimateModelCost(usage, astra);
        expect('cost' in result && result.cost).toBeCloseTo(7.125, 10);
    });

    it('有 long-context token 但價格沒有長 context 單價時不估算', () => {
        const usage = { inputTokens: 300_000, outputTokens: 0, longContext: { inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 } };
        expect(estimateModelCost(usage, { inputPerM: 10, outputPerM: 50 })).toEqual({ missing: 'longContextPrice' });
    });

    it('缺快取單價時回報 cachePrice', () => {
        expect(estimateModelCost({ inputTokens: 1, outputTokens: 0, cacheWriteTokens: 1 }, { inputPerM: 10, outputPerM: 50 })).toEqual({ missing: 'cachePrice' });
    });
});

describe('readCustomPricing', () => {
    // Field names and the rule that malformed entries are ignored come from the user's design (2026-10-03).
    it('cacheRead 與 cacheWrite 為選填；格式錯誤的項目整筆忽略', () => {
        expect(
            readCustomPricing({
                a: { input: 5, output: 20 },
                b: { input: 5, output: 20, cacheRead: 0.5, cacheWrite: 6 },
                c: { input: 5, output: 20, cacheRead: -1 },
                d: { input: 5, output: 20, cacheWrite: '6' },
            }),
        ).toEqual({
            a: { inputPerM: 5, outputPerM: 20 },
            b: { inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 6 },
        });
    });
});

describe('buildUsageView', () => {
    it('加總只含有價格的模型，並標出有模型缺價格', () => {
        const view = buildUsageView(
            'dev',
            'us-west-2',
            {
                periodStart: '2026-09-01T00:00:00.000Z',
                models: {
                    'us.anthropic.claude-opus-5-5': { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5', route: 'Geo', inputTokens: 1_000_000, outputTokens: 0, requests: 3 },
                    'us.openai.gpt-6-astra': { name: 'GPT-6 Astra', baseId: 'openai.gpt-6-astra', route: 'Geo', inputTokens: 2_000_000, outputTokens: 0, requests: 1 },
                },
            },
            new Date('2026-10-01T00:00:00Z'),
            TABLE,
            {},
            NO_CARDS,
        );
        expect(view.rows.map((r) => r.invokeId)).toEqual(['us.openai.gpt-6-astra', 'us.anthropic.claude-opus-5-5']);
        expect(view.totalInput).toBe(3_000_000);
        expect(view.totalCost).toBeCloseTo(4.4, 10);
        expect(view.pricedAll).toBe(false);
    });

    it('列出未快取輸入，總輸入另計；缺快取單價時標示沒有快取價格', () => {
        // Usage: GPT-6.1 Sol metadata.usage observed by the user on 2026-10-03; total input formula from AWS prompt-caching.html.
        const view = buildUsageView(
            'dev',
            'us-west-2',
            {
                periodStart: '2026-09-01T00:00:00.000Z',
                models: {
                    gpt: { name: 'GPT', baseId: 'openai.test', route: 'Geo', inputTokens: 2, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 19_001, requests: 1 },
                    legacy: { name: 'Claude Opus 5.5', baseId: 'anthropic.claude-opus-5-5', route: 'Geo', inputTokens: 10, outputTokens: 0, requests: 1 },
                },
            },
            new Date('2026-10-01T00:00:00Z'),
            TABLE,
            { 'openai.test': { inputPerM: 5, outputPerM: 20 } },
            NO_CARDS,
        );
        expect(view.rows[0]).toMatchObject({ invokeId: 'gpt', inputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 19_001, cost: undefined, missingPrice: 'cachePrice' });
        expect(view.rows[1]).toMatchObject({ invokeId: 'legacy', inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, missingPrice: undefined });
        expect(view.totalInput).toBe(19_013);
        expect(view.totalUncachedInput).toBe(12);
        expect(view.totalCacheWrite).toBe(19_001);
        expect(view.pricedAll).toBe(false);
    });

    it('model card 價格標示來源；有 long-context 請求但價格缺長 context 單價時標示', () => {
        // GPT-6 Sol Geo prices from model-card-openai-gpt-6-sol (fetched 2026-10-04).
        const geo = { inputPerM: 2.2, outputPerM: 11, cacheReadPerM: 0.22, cacheWritePerM: 2.75, longContext: { inputPerM: 4.4, outputPerM: 16.5, cacheReadPerM: 0.44, cacheWritePerM: 5.5 } };
        const long = { inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 };
        const view = buildUsageView(
            'dev',
            'us-west-2',
            {
                periodStart: '2026-09-01T00:00:00.000Z',
                models: {
                    sol: { name: 'GPT-6 Sol', baseId: 'openai.gpt-6-sol', route: 'Geo', inputTokens: 300_000, outputTokens: 0, requests: 1, longContext: long },
                    custom: { name: 'GPT', baseId: 'openai.test', route: 'Geo', inputTokens: 300_000, outputTokens: 0, requests: 1, longContext: long },
                },
            },
            new Date('2026-10-01T00:00:00Z'),
            undefined,
            { 'openai.test': { inputPerM: 5, outputPerM: 20 } },
            new Map([['openai.gpt-6-sol', { pricing: { geo } }]]),
        );
        const sol = view.rows.find((r) => r.invokeId === 'sol');
        expect(sol?.priceSource).toBe('modelCard');
        expect(sol?.cost).toBeCloseTo(1.32, 10);
        expect(view.rows.find((r) => r.invokeId === 'custom')).toMatchObject({ priceSource: 'custom', cost: undefined, missingPrice: 'longContextPrice' });
    });
});
