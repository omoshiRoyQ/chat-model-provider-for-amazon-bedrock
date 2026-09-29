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
        expect(opus).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000, thinking: 'adaptiveAlways', name: 'Claude Opus 5.5' });
    });

    it('模型卡寫明不支援 Native 的模型不列出（GPT - 5.4）', () => {
        const r = resolveModels(profiles, foundations, 'geo', true);
        expect(ids(r)).not.toContain('us.openai.gpt-5.4');
        expect(r.notes.join('\n')).toContain('openai.gpt-5.4');
    });

    it('資料表沒有的模型用保守值、不送 thinking，並寫進 notes', () => {
        const r = resolveModels(profiles, foundations, 'geo', true);
        const sonnet3 = r.models.find((m) => m.baseId === 'anthropic.claude-3-sonnet-20240229-v1:0');
        expect(sonnet3).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 4_096, thinking: 'none' });
        expect(r.notes.join('\n')).toContain('claude-3-sonnet');
    });

    it('找不到 foundation model 時：名稱改用去掉地區字樣的 profile 名稱，不回報圖片輸入', () => {
        const sonnet3 = resolveModels(profiles, foundations, 'geo', true).models.find((m) => m.baseId.includes('claude-3-sonnet'));
        expect(sonnet3?.name).toBe('Anthropic Claude 3 Sonnet');
        expect(sonnet3?.imageInput).toBe(false);
    });

    it('imageInput 依 foundation model 的 inputModalities', () => {
        const r = resolveModels(profiles, foundations, 'geo', false);
        expect(r.models.find((m) => m.baseId === OPUS_55)?.imageInput).toBe(true);
        expect(r.models.find((m) => m.baseId.startsWith('meta.'))?.imageInput).toBe(false);
    });

    it('onlyClaudeAndGpt=true 只列 anthropic. 與 openai. 開頭的模型', () => {
        const r = resolveModels(profiles, foundations, 'geo', true);
        expect(r.models.every((m) => m.baseId.startsWith('anthropic.') || m.baseId.startsWith('openai.'))).toBe(true);
        expect(ids(resolveModels(profiles, foundations, 'geo', false))).toContain('us.meta.llama3-3-70b-instruct-v1:0');
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
});
