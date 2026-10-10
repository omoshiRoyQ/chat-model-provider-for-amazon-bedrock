/**
 * Model catalog and model-list composition logic (pure functions; no API calls).
 *
 * Token limits must have a source (AWS documentation or API response) cited here; never infer them from a model name.
 * ListInferenceProfiles and ListFoundationModels do not return token limits, so all values come from AWS model cards:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/<card>.html (accessed 2026-10-09).
 * The catalog is keyed by foundation model ID without an inference-profile prefix.
 * Models missing from the catalog use limits from model cards fetched at runtime (modelCardStore.ts), then conservative values.
 */

/**
 * Thinking parameter formats supported by models (verified with Converse on 2026-09-26; see thinking.ts).
 * - none: thinking is unsupported; send no parameters.
 * - extended: `thinking: { type: 'enabled', budget_tokens }`.
 * - adaptive: `thinking: { type: 'adaptive' }` with `output_config.effort`; `disabled` turns it off.
 * - adaptiveAlways: same as adaptive, but cannot be disabled (`disabled` is rejected).
 * - openai: `reasoning: { effort }`; effort accepts `none`.
 * - openaiNoNone: same as openai, but `none` is rejected.
 */
export type ThinkingStyle = 'none' | 'extended' | 'adaptive' | 'adaptiveAlways' | 'openai' | 'openaiNoNone';

interface CatalogEntry {
    /** Model-card page name, which is the last segment of the source URL. */
    readonly card: string;
    /** Context window (combined input and output limit); undefined if the model card does not specify it. */
    readonly contextWindow?: number;
    /** Maximum output tokens; undefined if the model card does not specify it. */
    readonly maxOutputTokens?: number;
    readonly thinking: ThinkingStyle;
    /** The model card states that bedrock-runtime (Converse) is unsupported; only Mantle is available. */
    readonly nativeUnsupported?: true;
    /** Listed as supporting explicit Converse cachePoint in https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html. */
    readonly promptCache?: true;
    /** Input tokens above which the model card's long-context prices apply to the whole request. */
    readonly longContextThreshold?: number;
}

const K = 1_000;
const M = 1_000_000;

export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
    // ?? Anthropic ?? Context, max output, and thinking formats come from each model card (accessed 2026-10-09).
    // promptCache follows the explicit prompt caching table in prompt-caching.html (Converse `messages` checkpoints; check-model-cards compares it).
    'anthropic.claude-3-haiku-20240307-v1:0': { card: 'model-card-anthropic-claude-3-haiku', contextWindow: 200 * K, maxOutputTokens: 4 * K, thinking: 'none' },
    'anthropic.claude-haiku-4-5-20251001-v1:0': { card: 'model-card-anthropic-claude-haiku-4-5', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended', promptCache: true },
    // Haiku 5.5: verified 2026-10-09 with ConverseStream (us-west-2, us.anthropic.claude-haiku-5-5): baseline=ok, adaptive=ok, disabled=ok.
    // longContextThreshold: the AWS card has no threshold, but the AWS price file has `_long_ctx` prices; Anthropic's pricing page says
    // "prompts over 100,000 tokens" (all input tokens, including cache reads and writes), the only Claude model with a long-context tier.
    'anthropic.claude-haiku-5-5': { card: 'model-card-anthropic-claude-haiku-5-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive', promptCache: true, longContextThreshold: 100 * K },
    'anthropic.claude-sonnet-4-20250514-v1:0': { card: 'model-card-anthropic-claude-sonnet-4', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended' },
    'anthropic.claude-sonnet-4-5-20250929-v1:0': { card: 'model-card-anthropic-claude-sonnet-4-5', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended', promptCache: true },
    'anthropic.claude-sonnet-4-6': { card: 'model-card-anthropic-claude-sonnet-4-6', contextWindow: 1 * M, maxOutputTokens: 64 * K, thinking: 'adaptive', promptCache: true },
    'anthropic.claude-sonnet-5': { card: 'model-card-anthropic-claude-sonnet-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive', promptCache: true },
    // Verified by the user on 2026-10-01: thinking cannot be turned off.
    'anthropic.claude-sonnet-5-5': { card: 'model-card-anthropic-claude-sonnet-5-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways', promptCache: true },
    'anthropic.claude-opus-4-1-20250805-v1:0': { card: 'model-card-anthropic-claude-opus-4-1', contextWindow: 200 * K, maxOutputTokens: 32 * K, thinking: 'extended' },
    'anthropic.claude-opus-4-5-20251101-v1:0': { card: 'model-card-anthropic-claude-opus-4-5', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended', promptCache: true },
    'anthropic.claude-opus-4-6-v1': { card: 'model-card-anthropic-claude-opus-4-6', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive', promptCache: true },
    'anthropic.claude-opus-4-7': { card: 'model-card-anthropic-claude-opus-4-7', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive', promptCache: true },
    'anthropic.claude-opus-4-8': { card: 'model-card-anthropic-claude-opus-4-8', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive', promptCache: true },
    'anthropic.claude-opus-5': { card: 'model-card-anthropic-claude-opus-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive', promptCache: true },
    // Model card: adaptive thinking is always on (`disabled` was verified to return ValidationException).
    'anthropic.claude-opus-5-5': { card: 'model-card-anthropic-claude-opus-5-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways', promptCache: true },
    'anthropic.claude-fable-5': { card: 'model-card-anthropic-claude-fable-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways', promptCache: true },
    'anthropic.claude-fable-5-1': { card: 'model-card-anthropic-claude-fable-5-1', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways', promptCache: true },
    // No model card was found for Claude 3 Sonnet, so it is omitted from the catalog and uses conservative values with a log entry.

    // ?? OpenAI ?? Limits come from each model card (rechecked 2026-10-04 with check-model-cards).
    // longContextThreshold comes from each card's Pricing section ("more than 272K input tokens", checked 2026-10-04).
    'openai.gpt-5.4': { card: 'model-card-openai-gpt-54', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', nativeUnsupported: true, longContextThreshold: 272_000 },
    'openai.gpt-5.5': { card: 'model-card-openai-gpt-55', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', nativeUnsupported: true, longContextThreshold: 272_000 },
    'openai.gpt-5.6-luna': { card: 'model-card-openai-gpt-56-luna', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', longContextThreshold: 272_000 },
    'openai.gpt-5.6-sol': { card: 'model-card-openai-gpt-56-sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', longContextThreshold: 272_000 },
    'openai.gpt-5.6-terra': { card: 'model-card-openai-gpt-56-terra', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', longContextThreshold: 272_000 },
    // GPT-6 Astra was verified to reject `none` for reasoning.effort. Luna and Sol could not be tested due to missing permissions,
    // so they are also marked openaiNoNone: `off` maps to `low`, which is confirmed to work for Astra.
    'openai.gpt-6-astra': { card: 'model-card-openai-gpt-6-astra', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openaiNoNone', longContextThreshold: 272_000 },
    'openai.gpt-6-luna': { card: 'model-card-openai-gpt-6-luna', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openaiNoNone', longContextThreshold: 272_000 },
    'openai.gpt-6-sol': { card: 'model-card-openai-gpt-6-sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openaiNoNone', longContextThreshold: 272_000 },
    // Verified 2026-10-04 with ConverseStream (us-west-2, us.openai.gpt-6.1-sol): baseline=ok, effort=low=ok, effort=none=ValidationException
    'openai.gpt-6.1-sol': { card: 'model-card-openai-gpt-6-1-sol', contextWindow: 1_000_000, maxOutputTokens: 131_072, thinking: 'openaiNoNone', longContextThreshold: 272_000 },
    // Verified 2026-10-01 with ConverseStream (us-west-2, bare model IDs): baseline, effort=low, and effort=none all succeeded.
    'openai.gpt-oss-120b-1:0': { card: 'model-card-openai-gpt-oss-120b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    'openai.gpt-oss-20b-1:0': { card: 'model-card-openai-gpt-oss-20b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    'openai.gpt-oss-safeguard-120b': { card: 'model-card-openai-gpt-oss-safeguard-120b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    'openai.gpt-oss-safeguard-20b': { card: 'model-card-openai-gpt-oss-safeguard-20b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    // Not added (2026-10-04): Claude 3.5 Haiku returned end-of-life ResourceNotFoundException; Claude Mythos 5.1 is gated and returned "The provided model identifier is invalid" with the available profile.
};

/** Results of developer probes (scripts/probe-models.mts); undefined fields were not determined. */
export interface ProbedCapabilities {
    /** False when ConverseStream rejected a request with toolConfig; such models are not listed. */
    readonly tools?: boolean;
    /** Overrides inputModalities from ListFoundationModels. */
    readonly image?: boolean;
    /**
     * Set when the model cannot be used by this extension for account-independent reasons (user decision, 2026-10-10); such models are not listed.
     * retired: end of life (ResourceNotFoundException). noConverse: ConverseStream does not support the model (ValidationException).
     * Account-specific failures (AccessDeniedException, Legacy usage status, data retention mode) must not use this field.
     */
    readonly unsupported?: 'retired' | 'noConverse';
}

/**
 * Keyed by foundation model ID. Paste lines printed by `pnpm run probe-models`. Models with a tools=false result or an image result are not probed again;
 * a model with only a tools=true result is still probed for images.
 * Models missing here are listed as before (user decision, 2026-10-10).
 */
export const PROBED_CAPABILITIES: Readonly<Record<string, ProbedCapabilities>> = {
    // Excluded 2026-10-10 (user decision): retired models and models that do not support Converse.
    'amazon.nova-2-5-sonic': { unsupported: 'noConverse' }, // ValidationException: This action doesn't support the model that you provided.
    'amazon.nova-2-sonic-v1:0': { unsupported: 'noConverse' }, // ValidationException: This action doesn't support the model that you provided.
    'amazon.nova-premier-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    'anthropic.claude-3-haiku-20240307-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    'anthropic.claude-3-sonnet-20240229-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    'meta.llama3-2-11b-instruct-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    'meta.llama3-2-1b-instruct-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    'meta.llama3-2-3b-instruct-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    'meta.llama3-2-90b-instruct-v1:0': { unsupported: 'retired' }, // ResourceNotFoundException: This model version has reached the end of its life.
    // Probed 2026-10-10 with ConverseStream (us-west-2, maxTokens=16); image result for Gemma 3 is valid (the maxTokens=1 run misjudged it).
    'google.gemma-3-12b-it': { tools: true, image: true },
    'google.gemma-3-27b-it': { tools: true, image: true },
    'google.gemma-3-4b-it': { tools: true, image: true },
    'moonshotai.kimi-k3': { tools: true, image: true },
    'openai.gpt-5.6-luna': { tools: true, image: true },
    'openai.gpt-5.6-sol': { tools: true, image: true },
    'openai.gpt-5.6-terra': { tools: true, image: true },
    'openai.gpt-6-astra': { tools: true, image: true },
    'openai.gpt-6-luna': { tools: true, image: true },
    'openai.gpt-6-sol': { tools: true, image: true },
    'openai.gpt-6.1-sol': { tools: true, image: true },
    'xai.grok-4.6': { tools: true, image: true },
    'xai.grok-4.7': { tools: true, image: true },
    // Probed 2026-10-10 with ConverseStream (us-west-2, maxTokens=1)
    'amazon.nova-2-lite-v1:0': { tools: true, image: true },
    'amazon.nova-lite-v1:0': { tools: true, image: true },
    'amazon.nova-micro-v1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'amazon.nova-pro-v1:0': { tools: true, image: true },
    'anthropic.claude-haiku-4-5-20251001-v1:0': { tools: true, image: true },
    'anthropic.claude-haiku-5-5': { tools: true, image: true },
    'anthropic.claude-opus-4-1-20250805-v1:0': { tools: true, image: true },
    'anthropic.claude-opus-4-5-20251101-v1:0': { tools: true, image: true },
    'anthropic.claude-opus-4-6-v1': { tools: true, image: true },
    'anthropic.claude-opus-4-7': { tools: true, image: true },
    'anthropic.claude-opus-4-8': { tools: true, image: true },
    'anthropic.claude-opus-5': { tools: true, image: true },
    'anthropic.claude-opus-5-5': { tools: true, image: true },
    'anthropic.claude-sonnet-4-5-20250929-v1:0': { tools: true, image: true },
    'anthropic.claude-sonnet-4-6': { tools: true, image: true },
    'anthropic.claude-sonnet-5': { tools: true, image: true },
    'anthropic.claude-sonnet-5-5': { tools: true, image: true },
    'deepseek.r1-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'deepseek.v3-v1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'deepseek.v3.2': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'meta.llama3-1-70b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'meta.llama3-1-8b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'meta.llama3-3-70b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'meta.llama3-70b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'meta.llama3-8b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'meta.llama4-maverick-17b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'meta.llama4-scout-17b-instruct-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'minimax.minimax-m2': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'minimax.minimax-m2.1': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'minimax.minimax-m2.5': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'mistral.devstral-2-123b': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'mistral.magistral-small-2509': { tools: true, image: true },
    'mistral.ministral-3-14b-instruct': { tools: true, image: true },
    'mistral.ministral-3-3b-instruct': { tools: true, image: true },
    'mistral.ministral-3-8b-instruct': { tools: true, image: true },
    'mistral.mistral-7b-instruct-v0:2': { tools: false }, // This model doesn't support tool use in streaming mode.
    'mistral.mistral-large-2402-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'mistral.mistral-large-2407-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'mistral.mistral-large-3-675b-instruct': { tools: true, image: true },
    'mistral.mixtral-8x7b-instruct-v0:1': { tools: false }, // This model doesn't support tool use in streaming mode.
    'mistral.pixtral-large-2502-v1:0': { tools: false }, // This model doesn't support tool use in streaming mode.
    'mistral.voxtral-mini-3b-2507': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'mistral.voxtral-small-24b-2507': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'moonshot.kimi-k2-thinking': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'moonshotai.kimi-k2.5': { tools: true, image: true },
    'nvidia.nemotron-nano-12b-v2': { tools: true, image: true },
    'nvidia.nemotron-nano-3-30b': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'nvidia.nemotron-nano-9b-v2': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'nvidia.nemotron-super-3-120b': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'openai.gpt-oss-120b-1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'openai.gpt-oss-20b-1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'openai.gpt-oss-safeguard-120b': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'openai.gpt-oss-safeguard-20b': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'qwen.qwen3-235b-a22b-2507-v1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'qwen.qwen3-32b-v1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'qwen.qwen3-coder-30b-a3b-v1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'qwen.qwen3-coder-480b-a35b-v1:0': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'qwen.qwen3-next-80b-a3b': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'qwen.qwen3-vl-235b-a22b': { tools: true, image: true },
    'writer.palmyra-vision-7b': { tools: false }, // The model returned the following errors: Mantle streaming error for requestId ede387b0-0a25-48f3-a26c-046c5c03e88c: ErrorEvent { error: APIError { type: "BadRequestError", code: Some(400), message: "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set", param: None } }
    'zai.glm-4.7': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'zai.glm-4.7-flash': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
    'zai.glm-5': { tools: true, image: false }, // This model doesn't support the image content block that you provided. Update the content block and try again.
};

/**
 * Conservative limits used when no source is available. Too large a value makes long requests fail with ValidationException;
 * too small a value makes VS Code trim history and attachments. 128K is the user's choice (2026-10-01): of the text models
 * with model cards on that date, only a few older ones had a context window below 128K.
 */
const CONSERVATIVE_CONTEXT_WINDOW = 128 * K;
const CONSERVATIVE_MAX_OUTPUT = 4_096;

export type InferenceScope = 'geo' | 'global';

/** Fields from ListInferenceProfiles used here. */
export interface ProfileSummary {
    readonly id: string;
    readonly name: string;
    readonly active: boolean;
}

/** Fields from ListFoundationModels used here. */
export interface FoundationSummary {
    readonly id: string;
    readonly name: string;
    readonly textOutput: boolean;
    readonly streaming: boolean;
    readonly onDemand: boolean;
    /** Whether inputModalities includes IMAGE. */
    readonly imageInput: boolean;
}

/** A resolved model ready to be returned to VS Code. */
export interface ResolvedModel {
    /** ID used to call Converse (an inference profile ID or foundation model ID). */
    readonly invokeId: string;
    /** Foundation model ID without a prefix. */
    readonly baseId: string;
    readonly name: string;
    /** Invocation scope, shown next to the model in the picker. */
    readonly route: 'Geo' | 'Global' | 'In-Region';
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    /** True when maxOutputTokens comes from the catalog or a model card rather than the conservative fallback. */
    readonly maxOutputSourced: boolean;
    readonly thinking: ThinkingStyle;
    /**
     * From PROBED_CAPABILITIES, then inputModalities returned by ListFoundationModels; never inferred from a model name.
     * True when neither is available (user decision): Bedrock rejects unsupported images with an explicit error.
     */
    readonly imageInput: boolean;
    /** Whether the provider adds Converse cachePoint blocks; only true for catalog entries marked promptCache. */
    readonly promptCache: boolean;
    /** From the catalog, or the model card for models missing from it; undefined means no long-context pricing tier. */
    readonly longContextThreshold?: number;
}

/** Token limits parsed from an AWS model card at runtime. */
export interface CardLimits {
    readonly card: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly converse?: boolean;
    readonly longContextThreshold?: number;
}

interface ResolveResult {
    readonly models: ResolvedModel[];
    /** Notes to write to the log (for example, conservative values or exclusion reasons). */
    readonly notes: string[];
    /** Listed models with neither a catalog entry nor a cached model card. */
    readonly unknownIds: string[];
    /** Whether any listed model takes its limits from a cached model card. */
    readonly usesModelCards: boolean;
}

const GLOBAL_PREFIX = 'global.';

/** The first segment of an inference profile ID is the route prefix (such as us., eu., apac., or global.); the remainder is the foundation model ID. */
function splitProfileId(id: string): { prefix: string; baseId: string } | undefined {
    const dot = id.indexOf('.');
    if (dot <= 0) {
        return undefined;
    }
    return { prefix: id.slice(0, dot + 1), baseId: id.slice(dot + 1) };
}

function isClaudeOrGpt(baseId: string): boolean {
    return baseId.startsWith('anthropic.') || baseId.startsWith('openai.');
}

/**
 * Builds the model list from inference profiles and foundation models.
 *
 * - geo: use only non-global profiles (the prefix depends on the region, such as us. or eu.) so data stays within that geography.
 *   Omit models with only a global profile to prevent sending data outside the selected geography.
 * - global: prefer a global profile; fall back to geo when the model has no global profile (geo is a subset of global).
 * - If there is no profile, call an on-demand foundation model by its bare ID in the same region.
 */
export function resolveModels(
    profiles: readonly ProfileSummary[],
    foundations: readonly FoundationSummary[],
    scope: InferenceScope,
    onlyClaudeAndGpt: boolean,
    cardLimits: ReadonlyMap<string, CardLimits> = new Map(),
    probed: Readonly<Record<string, ProbedCapabilities>> = PROBED_CAPABILITIES,
): ResolveResult {
    const notes: string[] = [];
    const unknownIds: string[] = [];
    let usesModelCards = false;
    const foundationById = new Map(foundations.map((f) => [f.id, f]));

    // Select one profile for each foundation model.
    const geoByBase = new Map<string, ProfileSummary>();
    const globalByBase = new Map<string, ProfileSummary>();
    for (const profile of profiles) {
        if (!profile.active) {
            continue;
        }
        const split = splitProfileId(profile.id);
        if (!split) {
            continue;
        }
        const target = split.prefix === GLOBAL_PREFIX ? globalByBase : geoByBase;
        const existing = target.get(split.baseId);
        if (existing) {
            notes.push(`Multiple ${split.prefix === GLOBAL_PREFIX ? 'global' : 'geo'} profiles found for ${split.baseId}; using ${existing.id} and skipping ${profile.id}`);
            continue;
        }
        target.set(split.baseId, profile);
    }

    const picked = new Map<string, { invokeId: string; route: ResolvedModel['route']; profileName?: string }>();
    const baseIds = new Set([...geoByBase.keys(), ...globalByBase.keys()]);
    for (const baseId of baseIds) {
        const geo = geoByBase.get(baseId);
        const global = globalByBase.get(baseId);
        if (scope === 'global' && global) {
            picked.set(baseId, { invokeId: global.id, route: 'Global', profileName: global.name });
        } else if (geo) {
            picked.set(baseId, { invokeId: geo.id, route: 'Geo', profileName: geo.name });
        } else if (global) {
            notes.push(`${baseId} has only a global profile and is omitted because inferenceScope=geo`);
        }
    }
    for (const f of foundations) {
        if (!picked.has(f.id) && f.onDemand && f.textOutput && f.streaming && !isNonChatModel(f.id)) {
            picked.set(f.id, { invokeId: f.id, route: 'In-Region' });
        }
    }

    const models: ResolvedModel[] = [];
    for (const [baseId, pick] of picked) {
        if (onlyClaudeAndGpt && !isClaudeOrGpt(baseId)) {
            continue;
        }
        const foundation = foundationById.get(baseId);
        if (foundation && (!foundation.textOutput || !foundation.streaming)) {
            // For example, profiles for image-generation or embedding models cannot be used for Chat.
            continue;
        }
        const entry = CATALOG[baseId];
        if (entry?.nativeUnsupported) {
            notes.push(`${baseId} is omitted because model card ${entry.card} does not support Native Converse`);
            continue;
        }
        const probe = probed[baseId];
        if (probe?.unsupported) {
            const reason = probe.unsupported === 'retired' ? 'the model has reached end of life' : 'ConverseStream does not support the model';
            notes.push(`${baseId} is omitted because ${reason} (user decision 2026-10-10)`);
            continue;
        }
        if (probe?.tools === false) {
            notes.push(`${baseId} is omitted because ConverseStream rejected tool use when probed`);
            continue;
        }
        const card = entry ? undefined : cardLimits.get(baseId);
        if (card?.converse === false) {
            notes.push(`${baseId} is omitted because model card ${card.card} does not list Converse for bedrock-runtime`);
            continue;
        }
        const source = entry ?? card;
        const contextWindow = source?.contextWindow ?? CONSERVATIVE_CONTEXT_WINDOW;
        const maxOutputTokens = source?.maxOutputTokens ?? CONSERVATIVE_MAX_OUTPUT;
        if (!source) {
            unknownIds.push(baseId);
            notes.push(`No catalog entry or model card found for ${baseId}; using conservative limits context=${contextWindow}, maxOutput=${maxOutputTokens}, and omitting thinking parameters`);
        } else {
            if (!entry) {
                usesModelCards = true;
                notes.push(`${baseId} is not in the catalog; using limits from AWS model card ${source.card} (context=${contextWindow}, maxOutput=${maxOutputTokens}) and omitting thinking parameters`);
            }
            if (source.contextWindow === undefined || source.maxOutputTokens === undefined) {
                notes.push(`Model card ${source.card} for ${baseId} does not specify ${source.contextWindow === undefined ? 'context window' : 'max output'}; using a conservative value for that field`);
            }
        }
        models.push({
            invokeId: pick.invokeId,
            baseId,
            name: foundation?.name ?? stripProfileNamePrefix(pick.profileName ?? baseId),
            route: pick.route,
            contextWindow,
            maxOutputTokens,
            maxOutputSourced: source?.maxOutputTokens !== undefined,
            thinking: entry?.thinking ?? 'none',
            imageInput: probe?.image ?? foundation?.imageInput ?? true,
            promptCache: entry?.promptCache ?? false,
            longContextThreshold: source?.longContextThreshold,
        });
    }
    models.sort((a, b) => a.baseId.localeCompare(b.baseId));
    return { models, notes, unknownIds, usesModelCards };
}

/**
 * An on-demand model that outputs text but is not a chat model (rerank). ListFoundationModels has no field to distinguish it,
 * so exclude it by ID; this filter only applies when listing all models.
 */
function isNonChatModel(id: string): boolean {
    return id.includes('rerank');
}

/** Profile names include a region (for example, "US Anthropic Claude 3 Haiku"); use this only when no foundation-model name is available. */
function stripProfileNamePrefix(name: string): string {
    return name.replace(/^(US|EU|APAC|Global|GLOBAL)\s+/, '');
}
