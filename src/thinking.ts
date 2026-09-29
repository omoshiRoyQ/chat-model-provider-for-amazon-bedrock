import type { Document } from './convert';
import type { ThinkingStyle } from './models';

/** Per-model thinking effort levels. `default` sends no parameters and lets the model use its default. */
export type ThinkingEffort = 'default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Extended thinking (`budget_tokens`) has no effort levels, so define a local mapping here.
 * Converse requires `budget_tokens` to be at least 1024 and less than `maxTokens`.
 */
const EXTENDED_BUDGET: Readonly<Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', number>> = {
    low: 2_048,
    medium: 8_192,
    high: 16_384,
    xhigh: 24_576,
    max: 32_768,
};
const MIN_BUDGET = 1_024;

export interface ThinkingRequest {
    /** Passed to Converse as additionalModelRequestFields. */
    readonly fields?: Record<string, Document>;
    /** Explicit maxTokens required for extended thinking. */
    readonly maxTokens?: number;
    /** A note to write to the log (for example, why a setting was adjusted). */
    readonly note?: string;
}

/**
 * Builds Converse request parameters from the model's thinking format and the user's setting.
 * Each format was verified with Converse on 2026-09-26:
 * - Haiku 4.5: `thinking.enabled` with budget_tokens 1024 succeeded.
 * - Sonnet 4.6: `thinking.adaptive` with `output_config.effort` and `thinking.disabled` both succeeded.
 * - Opus 5.5: `thinking.disabled` returned ValidationException; `adaptive` with effort `max` succeeded.
 * - GPT-6 Astra: `reasoning.effort=low` succeeded; `none` returned ValidationException (only low through max are accepted).
 */
export function buildThinkingRequest(
    style: ThinkingStyle,
    effort: ThinkingEffort,
    maxOutputTokens: number,
    toolChoiceRequired: boolean,
): ThinkingRequest {
    if (effort === 'default' || style === 'none') {
        return {};
    }
    switch (style) {
        case 'extended': {
            if (effort === 'off') {
                // Claude's extended thinking is off by default; omit the parameters.
                return {};
            }
            if (toolChoiceRequired) {
                // AWS documentation: extended thinking cannot be combined with toolChoice any.
                return { note: 'Extended thinking cannot be combined with toolChoice=any; thinking is disabled for this request' };
            }
            // Keep the budget at least 1024 and reserve half of the output space for the response itself.
            const cap = Math.floor(maxOutputTokens / 2);
            if (cap < MIN_BUDGET) {
                return { note: `maxOutputTokens=${maxOutputTokens} is too small to enable extended thinking` };
            }
            const budget = Math.min(EXTENDED_BUDGET[effort], cap);
            return {
                fields: { thinking: { type: 'enabled', budget_tokens: budget } },
                maxTokens: maxOutputTokens,
                note: budget < EXTENDED_BUDGET[effort] ? `budget_tokens reduced to ${budget} to fit maxOutputTokens` : undefined,
            };
        }
        case 'adaptive':
        case 'adaptiveAlways': {
            if (effort === 'off') {
                if (style === 'adaptive') {
                    return { fields: { thinking: { type: 'disabled' } } };
                }
                return {
                    fields: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
                    note: 'This model cannot disable thinking; using effort=low instead of off',
                };
            }
            return { fields: { thinking: { type: 'adaptive' }, output_config: { effort } } };
        }
        case 'openai':
        case 'openaiNoNone': {
            if (effort === 'off') {
                if (style === 'openai') {
                    return { fields: { reasoning: { effort: 'none' } } };
                }
                return { fields: { reasoning: { effort: 'low' } }, note: 'This model does not accept effort=none; using effort=low instead of off' };
            }
            return { fields: { reasoning: { effort } } };
        }
    }
}
