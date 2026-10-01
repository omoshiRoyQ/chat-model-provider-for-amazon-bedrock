/**
 * Model catalog and model-list composition logic (pure functions; no API calls).
 *
 * Token limits must have a source (AWS documentation or API response) cited here; never infer them from a model name.
 * ListInferenceProfiles and ListFoundationModels do not return token limits, so all values come from AWS model cards:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/<card>.html (accessed 2026-09-25).
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
}

const K = 1_000;
const M = 1_000_000;

export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
    // ── Anthropic ── Context, max output, and thinking formats come from each model card (accessed 2026-09-25).
    'anthropic.claude-3-haiku-20240307-v1:0': { card: 'model-card-anthropic-claude-3-haiku', contextWindow: 200 * K, maxOutputTokens: 4 * K, thinking: 'none' },
    'anthropic.claude-haiku-4-5-20251001-v1:0': { card: 'model-card-anthropic-claude-haiku-4-5', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended' },
    'anthropic.claude-sonnet-4-20250514-v1:0': { card: 'model-card-anthropic-claude-sonnet-4', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended' },
    'anthropic.claude-sonnet-4-5-20250929-v1:0': { card: 'model-card-anthropic-claude-sonnet-4-5', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended' },
    'anthropic.claude-sonnet-4-6': { card: 'model-card-anthropic-claude-sonnet-4-6', contextWindow: 1 * M, maxOutputTokens: 64 * K, thinking: 'adaptive' },
    'anthropic.claude-sonnet-5': { card: 'model-card-anthropic-claude-sonnet-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive' },
    // Verified by the user on 2026-10-01: thinking cannot be turned off.
    'anthropic.claude-sonnet-5-5': { card: 'model-card-anthropic-claude-sonnet-5-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways' },
    'anthropic.claude-opus-4-1-20250805-v1:0': { card: 'model-card-anthropic-claude-opus-4-1', contextWindow: 200 * K, maxOutputTokens: 32 * K, thinking: 'extended' },
    'anthropic.claude-opus-4-5-20251101-v1:0': { card: 'model-card-anthropic-claude-opus-4-5', contextWindow: 200 * K, maxOutputTokens: 64 * K, thinking: 'extended' },
    'anthropic.claude-opus-4-6-v1': { card: 'model-card-anthropic-claude-opus-4-6', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive' },
    'anthropic.claude-opus-4-7': { card: 'model-card-anthropic-claude-opus-4-7', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive' },
    'anthropic.claude-opus-4-8': { card: 'model-card-anthropic-claude-opus-4-8', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive' },
    'anthropic.claude-opus-5': { card: 'model-card-anthropic-claude-opus-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptive' },
    // Model card: adaptive thinking is always on (`disabled` was verified to return ValidationException).
    'anthropic.claude-opus-5-5': { card: 'model-card-anthropic-claude-opus-5-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways' },
    'anthropic.claude-fable-5': { card: 'model-card-anthropic-claude-fable-5', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways' },
    'anthropic.claude-fable-5-1': { card: 'model-card-anthropic-claude-fable-5-1', contextWindow: 1 * M, maxOutputTokens: 128 * K, thinking: 'adaptiveAlways' },
    // No model card was found for Claude 3 Sonnet, so it is omitted from the catalog and uses conservative values with a log entry.

    // ── OpenAI ── Limits come from each model card (rechecked 2026-10-01 with check-model-cards).
    'openai.gpt-5.4': { card: 'model-card-openai-gpt-54', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', nativeUnsupported: true },
    'openai.gpt-5.5': { card: 'model-card-openai-gpt-55', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai', nativeUnsupported: true },
    'openai.gpt-5.6-luna': { card: 'model-card-openai-gpt-56-luna', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai' },
    'openai.gpt-5.6-sol': { card: 'model-card-openai-gpt-56-sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai' },
    'openai.gpt-5.6-terra': { card: 'model-card-openai-gpt-56-terra', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openai' },
    // GPT-6 Astra was verified to reject `none` for reasoning.effort. Luna and Sol could not be tested due to missing permissions,
    // so they are also marked openaiNoNone: `off` maps to `low`, which is confirmed to work for Astra.
    'openai.gpt-6-astra': { card: 'model-card-openai-gpt-6-astra', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openaiNoNone' },
    'openai.gpt-6-luna': { card: 'model-card-openai-gpt-6-luna', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openaiNoNone' },
    'openai.gpt-6-sol': { card: 'model-card-openai-gpt-6-sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, thinking: 'openaiNoNone' },
    // Verified 2026-10-01 with ConverseStream (us-west-2, bare model IDs): baseline, effort=low, and effort=none all succeeded.
    'openai.gpt-oss-120b-1:0': { card: 'model-card-openai-gpt-oss-120b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    'openai.gpt-oss-20b-1:0': { card: 'model-card-openai-gpt-oss-20b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    'openai.gpt-oss-safeguard-120b': { card: 'model-card-openai-gpt-oss-safeguard-120b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    'openai.gpt-oss-safeguard-20b': { card: 'model-card-openai-gpt-oss-safeguard-20b', contextWindow: 128 * K, maxOutputTokens: 16 * K, thinking: 'openai' },
    // Not added (2026-10-01): Claude 3.5 Haiku returned end-of-life ResourceNotFoundException; Claude Mythos 5.1 and GPT-6.1 Sol could not be tested with the available profile.
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
    readonly thinking: ThinkingStyle;
    /**
     * Determined from inputModalities returned by ListFoundationModels; never inferred from a model name.
     * True when foundation-model data is unavailable (user decision): Bedrock rejects unsupported images with an explicit error.
     */
    readonly imageInput: boolean;
}

/** Token limits parsed from an AWS model card at runtime. */
export interface CardLimits {
    readonly card: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly converse?: boolean;
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
            thinking: entry?.thinking ?? 'none',
            imageInput: foundation?.imageInput ?? true,
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
