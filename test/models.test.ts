import { describe, expect, it } from 'vitest';
import { resolveModels, type FoundationSummary, type ProfileSummary } from '../src/models';

/**
 * Expected token limits and thinking formats come from AWS model cards (CATALOG in src/models.ts).
 * Scope rules come from the user's decisions (geo by default, optional global, and Claude/GPT-only by default).
 * Test ID formats follow actual ListInferenceProfiles and ListFoundationModels results from us-west-2 on 2026-09-26.
 */

const profile = (id: string, name = id, active = true): ProfileSummary => ({ id, name, active });
const foundation = (id: string, name: string, extra: Partial<FoundationSummary> = {}): FoundationSummary => ({
    id,
    name,
    textOutput: true,
    streaming: true,
    onDemand: false,
    imageInput: true,
    ...extra,
});

const OPUS_55 = 'anthropic.claude-opus-5-5';
const OPUS_41 = 'anthropic.claude-opus-4-1-20250805-v1:0';

const profiles = [
    profile(`us.${OPUS_55}`, 'US Anthropic Claude Opus 5.5'),
    profile(`global.${OPUS_55}`, 'Global Anthropic Claude Opus 5.5'),
    profile(`us.${OPUS_41}`, 'US Claude Opus 4.1'),
    profile('global.openai.gpt-6-sol', 'Global OpenAI GPT-6 Sol'),
    profile('us.openai.gpt-5.4', 'US OpenAI GPT 5.4'),
    profile('us.anthropic.claude-3-sonnet-20240229-v1:0', 'US Anthropic Claude 3 Sonnet'),
    profile('us.meta.llama3-3-70b-instruct-v1:0', 'US Meta Llama 3.3 70B'),
    profile('us.cohere.embed-v4:0', 'US Cohere Embed v4'),
];
const foundations = [
    foundation(OPUS_55, 'Claude Opus 5.5'),
    foundation(OPUS_41, 'Claude Opus 4.1'),
    foundation('openai.gpt-6-sol', 'GPT-6 Sol'),
    foundation('openai.gpt-5.4', 'GPT 5.4'),
    foundation('meta.llama3-3-70b-instruct-v1:0', 'Llama 3.3 70B', { imageInput: false }),
    foundation('cohere.embed-v4:0', 'Embed v4', { textOutput: false }),
    foundation('openai.gpt-oss-20b-1:0', 'gpt-oss-20b', { onDemand: true, imageInput: false }),
    foundation('cohere.rerank-v3-5:0', 'Rerank 3.5', { onDemand: true, imageInput: false }),
];

const ids = (r: ReturnType<typeof resolveModels>) => r.models.map((m) => m.invokeId);

describe('resolveModels', () => {
    it('geo：用地理區 profile，只有 global profile 的模型不列出', () => {
        const r = resolveModels(profiles, foundations, 'geo', true);
        expect(ids(r)).toContain(
            `us.${OPUS_55}`);
        expect(ids(r)).not.toContain('global.openai.gpt-6-sol');
        expect(r.notes.join('\n')).toContain('openai.gpt-6-sol has only a global profile');
    });

    it('global：優先用 global profile，沒有時退回地理區 profile', () => {
        const r = resolveModels(profiles, foundations, 'global', true);
        expect(ids(r)).toContain(`global.${OPUS_55}`);
        expect(ids(r)).toContain('global.openai.gpt-6-sol');
        expect(ids(r)).toContain(`us.${OPUS_41}`);
        expect(r.models.find((m) => m.baseId === OPUS_41)?.route).toBe('Geo');
    });

    it('token 上限與 thinking 格式取自模型卡資料表', () => {
        const opus = resolveModels(profiles, foundations, 'geo', true).models.find((m) => m.baseId === OPUS_55);
        expect(opus).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000, maxOutputSourced: true, thinking: 'adaptiveAlways', name: 'Claude Opus 5.5' });
    });

    it('模型卡寫明不支援 Native 的模型不列出（GPT - 5.4）', () => {
        const r = resolveModels(profiles, foundations, 'geo', true);
        expect(ids(r)).not.toContain('us.openai.gpt-5.4');
        expect(r.notes.join('\n')).toContain('openai.gpt-5.4');
    });

    it('資料表沒有的模型用保守值、不送 thinking，並寫進 notes', () => {
        // Empty probe table: Claude 3 Sonnet is retired and excluded by the default table (user decision 2026-10-10).
        const r = resolveModels(profiles, foundations, 'geo', true, new Map(), {});
        const sonnet3 = r.models.find((m) => m.baseId === 'anthropic.claude-3-sonnet-20240229-v1:0');
        // Conservative context window 128K is the user's decision (2026-10-01).
        expect(sonnet3).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 4_096, maxOutputSourced: false, thinking: 'none' });
        expect(r.notes.join('\n')).toContain('claude-3-sonnet');
        expect(r.unknownIds).toEqual(['anthropic.claude-3-sonnet-20240229-v1:0']);
    });

    it('資料表沒有、但已快取 model card 的模型用 model card 的數字，thinking 仍不送', () => {
        // Llama 3.3 figures come from model-card-meta-llama-3-3-70b-instruct (fetched 2026-10-01).
        const cards = new Map([['meta.llama3-3-70b-instruct-v1:0', { card: 'model-card-meta-llama-3-3-70b-instruct', contextWindow: 128_000, maxOutputTokens: 4_000 }]]);
        const r = resolveModels(profiles, foundations, 'geo', false, cards, {});
        expect(r.models.find((m) => m.baseId === 'meta.llama3-3-70b-instruct-v1:0')).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 4_000, maxOutputSourced: true, thinking: 'none' });
        expect(r.unknownIds).not.toContain('meta.llama3-3-70b-instruct-v1:0');
        expect(r.notes.join('\n')).toContain('model-card-meta-llama-3-3-70b-instruct');
    });

    it('model card 寫明 bedrock-runtime 不支援 Converse 的模型不列出', () => {
        // model-card-amazon-nova-2-sonic (fetched 2026-10-01) lists only InvokeModelWithBidirectionalStream.
        const sonic = 'amazon.nova-2-sonic-v1:0';
        const cards = new Map([[sonic, { card: 'model-card-amazon-nova-2-sonic', contextWindow: 1_000_000, maxOutputTokens: 64_000, converse: false }]]);
        // Empty probe table: Nova 2 Sonic is excluded by the default table, so this exercises the model card path only.
        const r = resolveModels([], [foundation(sonic, 'Nova 2 Sonic', { onDemand: true })], 'geo', false, cards, {});
        expect(ids(r)).not.toContain(sonic);
        expect(r.notes.join('\n')).toContain('does not list Converse');
    });

    it('資料表有的模型優先用資料表，不用 model card', () => {
        const cards = new Map([[OPUS_55, { card: 'model-card-other', contextWindow: 8_000, maxOutputTokens: 1_000 }]]);
        const opus = resolveModels(profiles, foundations, 'geo', true, cards).models.find((m) => m.baseId === OPUS_55);
        expect(opus).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000, thinking: 'adaptiveAlways' });
    });

    it('找不到 foundation model 時：名稱改用去掉地區字樣的 profile 名稱，並視為支援圖片輸入', () => {
        // Expected imageInput=true is the user's decision (2026-09-30): Bedrock rejects unsupported images explicitly.
        // Empty probe table: Claude 3 Sonnet is retired and excluded by default (user decision 2026-10-10).
        const sonnet3 = resolveModels(profiles, foundations, 'geo', true, new Map(), {}).models.find((m) => m.baseId.includes('claude-3-sonnet'));
        expect(sonnet3?.name).toBe('Anthropic Claude 3 Sonnet');
        expect(sonnet3?.imageInput).toBe(true);
    });

    it('沒有 ListFoundationModels 資料時仍從 inference profile 列出模型，thinking 格式取自模型卡資料表', () => {
        const r = resolveModels(profiles, [], 'geo', true);
        const opus = r.models.find((m) => m.baseId === OPUS_55);
        expect(opus).toMatchObject({ invokeId: `us.${OPUS_55}`, thinking: 'adaptiveAlways', imageInput: true });
    });

    it('promptCache 只對 prompt-caching.html 列出的 Claude 開啟（Opus 4.1 未列出；GPT 與資料表沒有的模型不開）', () => {
        // Empty probe table so that Claude 3 Sonnet (retired, excluded by default) is still listed for the non-caching check.
        const r = resolveModels(profiles, foundations, 'global', true, new Map(), {});
        const cache = (base: string) => r.models.find((m) => m.baseId === base)?.promptCache;
        expect(cache(OPUS_55)).toBe(true);
        expect(cache(OPUS_41)).toBe(false);
        expect(cache('openai.gpt-6-sol')).toBe(false);
        expect(cache('anthropic.claude-3-sonnet-20240229-v1:0')).toBe(false);
    });

    it('longContextThreshold 來自資料表；資料表沒有的模型改用 model card；Claude 沒有', () => {
        // 272,000 from the GPT model cards' Pricing sections (2026-10-04); the non-catalog card reuses that page figure.
        const sol61 = 'openai.gpt-uncataloged';
        const cards = new Map([[sol61, { card: 'model-card-openai-gpt-6-1-sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, longContextThreshold: 272_000 }]]);
        const r = resolveModels([...profiles, profile(`global.${sol61}`)], foundations, 'global', true, cards);
        expect(r.models.find((m) => m.baseId === 'openai.gpt-6-sol')?.longContextThreshold).toBe(272_000);
        expect(r.models.find((m) => m.baseId === sol61)?.longContextThreshold).toBe(272_000);
        expect(r.models.find((m) => m.baseId === OPUS_55)?.longContextThreshold).toBeUndefined();
    });

    it('Claude Haiku 5.5 的 longContextThreshold 為 100K', () => {
        // 100,000 from Anthropic's pricing page ("prompts over 100,000 tokens", 2026-10-09); AWS price file lists `_long_ctx` prices for the model.
        const haiku = 'anthropic.claude-haiku-5-5';
        const r = resolveModels([profile(`us.${haiku}`)], [foundation(haiku, 'Claude Haiku 5.5')], 'geo', true);
        expect(r.models.find((m) => m.baseId === haiku)).toMatchObject({ longContextThreshold: 100_000, contextWindow: 1_000_000, maxOutputTokens: 128_000, promptCache: true });
    });

    it('imageInput 依 foundation model 的 inputModalities', () => {
        // Empty probe table: Llama 3.3 is probed tools=false, so it would otherwise be omitted.
        const r = resolveModels(profiles, foundations, 'geo', false, new Map(), {});
        expect(r.models.find((m) => m.baseId === OPUS_55)?.imageInput).toBe(true);
        expect(r.models.find((m) => m.baseId.startsWith('meta.'))?.imageInput).toBe(false);
    });

    it('實測結果：工具被拒的模型不列出，圖片實測優先於 inputModalities，沒測過的照舊列出', () => {
        // Rules are the user's decisions (2026-10-10); Mixtral's tool rejection was observed in the user's log on 2026-10-10.
        const mixtral = 'mistral.mixtral-8x7b-instruct-v0:1';
        const probed = { [mixtral]: { tools: false }, [OPUS_55]: { tools: true, image: false }, 'meta.llama3-3-70b-instruct-v1:0': { image: true } };
        const r = resolveModels(profiles, [...foundations, foundation(mixtral, 'Mixtral 8x7B Instruct', { onDemand: true })], 'geo', false, new Map(), probed);
        expect(ids(r)).not.toContain(mixtral);
        expect(r.notes.join('\n')).toContain(`${mixtral} is omitted because ConverseStream rejected tool use`);
        expect(r.models.find((m) => m.baseId === OPUS_55)?.imageInput).toBe(false);
        expect(r.models.find((m) => m.baseId.startsWith('meta.'))?.imageInput).toBe(true);
        expect(r.models.find((m) => m.baseId === OPUS_41)?.imageInput).toBe(true);
    });

    it('onlyClaudeAndGpt=true 只列 anthropic. 與 openai. 開頭的模型', () => {
        const r = resolveModels(profiles, foundations, 'geo', true);
        expect(r.models.every((m) => m.baseId.startsWith('anthropic.') || m.baseId.startsWith('openai.'))).toBe(true);
        expect(ids(resolveModels(profiles, foundations, 'geo', false, new Map(), {}))).toContain('us.meta.llama3-3-70b-instruct-v1:0');
    });

    it('排除輸出不是文字的模型與 rerank；沒有 profile 的 on-demand 模型以裸 ID 在同區呼叫', () => {
        const r = resolveModels(profiles, foundations, 'geo', false);
        expect(ids(r)).not.toContain('us.cohere.embed-v4:0');
        expect(ids(r)).not.toContain('cohere.rerank-v3-5:0');
        expect(r.models.find((m) => m.invokeId === 'openai.gpt-oss-20b-1:0')?.route).toBe('In-Region');
    });

    it('略過非 ACTIVE 的 profile', () => {
        const r = resolveModels([profile(`us.${OPUS_55}`, 'x', false)], foundations, 'geo', true);
        expect(ids(r)).not.toContain(`us.${OPUS_55}`);
    });

    it('已下線或不支援 Converse 的 9 個模型一律略過，並寫入 note（使用者決定 2026-10-10）', () => {
        const excluded = [
            'amazon.nova-2-5-sonic',
            'amazon.nova-2-sonic-v1:0',
            'amazon.nova-premier-v1:0',
            'anthropic.claude-3-haiku-20240307-v1:0',
            'anthropic.claude-3-sonnet-20240229-v1:0',
            'meta.llama3-2-1b-instruct-v1:0',
            'meta.llama3-2-3b-instruct-v1:0',
            'meta.llama3-2-11b-instruct-v1:0',
            'meta.llama3-2-90b-instruct-v1:0',
        ];
        // Sources: the probe log in dist/probe-models-results.txt (2026-10-10, us-west-2): ResourceNotFoundException (end of life) or ValidationException (not a supported model for this action).
        const r = resolveModels(
            excluded.map((id) => profile(`us.${id}`)),
            excluded.map((id) => foundation(id, id)),
            'geo',
            false,
        );
        expect(ids(r)).toEqual([]);
        expect(r.unknownIds).toEqual([]);
        for (const id of excluded) {
            expect(r.notes.join('\n')).toContain(`${id} is omitted because`);
        }
    });

    it('帳號權限或帳號設定造成的失敗不排除（Pegasus 1.5、Pegasus 1.2、Palmyra X4/X5、GLM 5.3、Sonnet 4 Legacy、Fable 5）', () => {
        // Sources: dist/probe-models-results.txt (2026-10-10). AccessDeniedException (Marketplace or account not enabled), Legacy status, and data retention mode depend on the account, not the model.
        // twelvelabs.pegasus-1-5 is kept even though one earlier probe reported Converse unsupported, because a later run returned AccessDeniedException instead.
        const kept = [
            'twelvelabs.pegasus-1-5-v1:0',
            'twelvelabs.pegasus-1-2-v1:0',
            'writer.palmyra-x4-v1:0',
            'writer.palmyra-x5-v1:0',
            'zai.glm-5.3',
            'anthropic.claude-sonnet-4-20250514-v1:0',
            'anthropic.claude-fable-5',
            'anthropic.claude-fable-5-1',
        ];
        const r = resolveModels(
            kept.map((id) => profile(`us.${id}`)),
            kept.map((id) => foundation(id, id)),
            'geo',
            false,
        );
        expect(r.models.map((m) => m.baseId).sort()).toEqual([...kept].sort());
        expect(r.notes.join('\n')).not.toContain('user decision 2026-10-10');
    });
});
