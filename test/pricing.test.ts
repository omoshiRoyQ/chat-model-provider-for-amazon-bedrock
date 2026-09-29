import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { PriceStore } from '../src/priceStore';
import { estimateCost, lookupPrice, parseOffer, priceUrl, type PriceTable } from '../src/pricing';
import { buildUsageView } from '../src/usageView';

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
    // Should be skipped: batch, cache, hourly pricing, and models with input-only prices.
    product('d1', 'Claude Opus 4.1 (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount_Batch-Units', '7.5'),
    product('d2', 'Claude Fable 5 (Amazon Bedrock Edition)', 'USW2-MP:USW2_cache_read_tokens_standard-Units', '1.1'),
    product('d3', 'Claude 3.7 Sonnet (Amazon Bedrock Edition)', 'USW2-MP:USW2_ProvisionedThroughput_1MonthCommit_ModelUnits_Usage-Units', '158.4', 'hour'),
    product('d4', 'Claude Instant (Amazon Bedrock Edition)', 'USW2-MP:USW2_InputTokenCount-Units', '0.8'),
];
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

    it('略過批次、快取、每小時計價，以及缺輸出價的模型', () => {
        expect(Object.keys(table.models).sort()).toEqual(['Claude Haiku 4.5', 'Claude Opus 4.1', 'Claude Opus 5.5']);
        expect(table.publicationDate).toBe('2026-09-25T09:39:35Z');
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
        expect(lookupPrice(TABLE, {}, 'anthropic.claude-opus-5-5', 'Claude Opus 5.5', 'Global')?.price).toEqual({ inputPerM: 4, outputPerM: 20 });
        expect(lookupPrice(TABLE, {}, 'anthropic.claude-opus-5-5', 'Claude Opus 5.5', 'In-Region')?.price).toEqual({ inputPerM: 4.4, outputPerM: 22 });
    });

    it('自訂價格優先；價格表沒有的模型（GPT）回傳 undefined', () => {
        const custom = { 'openai.gpt-6-astra': { inputPerM: 5, outputPerM: 20 } };
        expect(lookupPrice(TABLE, custom, 'openai.gpt-6-astra', 'GPT-6 Astra', 'Geo')).toEqual({ price: custom['openai.gpt-6-astra'], source: 'custom' });
        expect(lookupPrice(TABLE, {}, 'openai.gpt-6-astra', 'GPT-6 Astra', 'Geo')).toBeUndefined();
    });

    it('名稱帶「Anthropic 」前綴（找不到 foundation model 時）也能比對', () => {
        expect(lookupPrice(TABLE, {}, 'anthropic.claude-3-sonnet-20240229-v1:0', 'Anthropic Claude 3 Sonnet', 'Geo')?.price).toEqual({ inputPerM: 3, outputPerM: 15 });
    });

    it('1M 輸入、100K 輸出的費用', () => {
        expect(estimateCost(1_000_000, 100_000, { inputPerM: 4.4, outputPerM: 22 })).toBeCloseTo(6.6, 10);
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
        );
        expect(view.rows.map((r) => r.invokeId)).toEqual(['us.openai.gpt-6-astra', 'us.anthropic.claude-opus-5-5']);
        expect(view.totalInput).toBe(3_000_000);
        expect(view.totalCost).toBeCloseTo(4.4, 10);
        expect(view.pricedAll).toBe(false);
    });
});
