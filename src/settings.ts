import * as vscode from 'vscode';
import type { InferenceScope } from './models';
import type { CustomPrices, ModelPrice } from './pricing';

/** Values for `amazonBedrockProvider.modelFilter`. */
export type ModelFilter = 'claudeAndGpt' | 'all';

/** Extension settings. Read VS Code settings on each access so changes take effect immediately. */
export interface BedrockSettings {
    /** Profile name from `~/.aws/config`; an empty string means it has not been configured. */
    readonly profile: string;
    /** AWS region; an empty string lets the SDK resolve it from the profile. */
    readonly region: string;
    readonly modelFilter: ModelFilter;
    readonly inferenceScope: InferenceScope;
    /** Day of the month (1–31) to reset token totals; use the last day when the month is shorter. */
    readonly usageResetDay: number;
    /** UTC hour (0–23) when token totals reset. */
    readonly usageResetHour: number;
    /** User-defined prices, which take precedence over the price table. */
    readonly customPricing: CustomPrices;
}

export const CONFIG_SECTION = 'amazonBedrockProvider';

export function readSettings(): BedrockSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    // settings.json can contain manually entered values outside the supported scope or enum; fall back to defaults in that case.
    const scope = config.get<string>('inferenceScope');
    return {
        profile: (config.get<string>('profile') ?? '').trim(),
        region: (config.get<string>('region') ?? '').trim(),
        modelFilter: config.get<string>('modelFilter') === 'all' ? 'all' : 'claudeAndGpt',
        inferenceScope: scope === 'global' ? 'global' : 'geo',
        usageResetDay: clampInt(config.get<number>('usageResetDay'), 1, 31, 1),
        usageResetHour: clampInt(config.get<number>('usageResetHour'), 0, 23, 0),
        customPricing: readCustomPricing(config.get<unknown>('customPricing')),
    };
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        return fallback;
    }
    return value;
}

const isPrice = (v: unknown): v is number => typeof v === 'number' && v >= 0;

/**
 * Keeps only entries with non-negative numeric input and output values, and optional cacheRead and cacheWrite values
 * that are non-negative numbers when present; ignores malformed entries.
 */
export function readCustomPricing(value: unknown): CustomPrices {
    const result: Record<string, ModelPrice> = {};
    if (!value || typeof value !== 'object') {
        return result;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const e = entry as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | null;
        if (!e || !isPrice(e.input) || !isPrice(e.output)) {
            continue;
        }
        if ((e.cacheRead !== undefined && !isPrice(e.cacheRead)) || (e.cacheWrite !== undefined && !isPrice(e.cacheWrite))) {
            continue;
        }
        result[key] = {
            inputPerM: e.input,
            outputPerM: e.output,
            ...(e.cacheRead !== undefined ? { cacheReadPerM: e.cacheRead } : {}),
            ...(e.cacheWrite !== undefined ? { cacheWritePerM: e.cacheWrite } : {}),
        };
    }
    return result;
}
