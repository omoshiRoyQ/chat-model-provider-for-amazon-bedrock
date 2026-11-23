import type * as vscode from 'vscode';
import type { TokenUsage } from './native';
import { migrationMarkerKey, type SharedUsageBacking } from './usageStorage';

/** Token and request totals for one model in the current period. */
export interface ModelUsage {
    readonly name: string;
    /** Foundation model ID without a route prefix, used for price lookup. */
    readonly baseId: string;
    readonly route: 'Geo' | 'Global' | 'In-Region';
    /** Uncached input tokens. */
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Missing in totals stored before prompt-cache tracking; treat as 0. */
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly requests: number;
    /** Subset of the totals from requests above the model's long-context threshold; missing when there were none. */
    readonly longContext?: UsageCounts;
}

export interface UsageCounts {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly requests: number;
}

/** Model fields that do not accumulate. */
export type ModelInfo = Pick<ModelUsage, 'name' | 'baseId' | 'route'>;

/** Current-period totals for one profile. Keys are invocation model IDs, including us. or global. prefixes, so Geo and Global are tracked separately. */
export interface UsagePeriod {
    /** Period start time (UTC ISO string). */
    readonly periodStart: string;
    /** Current schedule and next reset point; created on first read when the field is missing. */
    readonly resetSchedule?: {
        readonly day: number;
        readonly hour: number;
        readonly nextResetAt: string;
    };
    /** Time of the user's most recent manual reset; undefined if it has never been reset manually. */
    readonly manualResetAt?: string;
    readonly models: Readonly<Record<string, ModelUsage>>;
}

/** Reset point for a month; clamp days beyond the month's length to its last day (for example, day 31 becomes February 28 or 29). Date.UTC handles month overflow. */
function resetPointOf(year: number, month: number, day: number, hour: number): Date {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, lastDay), hour));
}

/** Start of the current period: use this month's reset point if it has passed, otherwise use last month's. */
export function currentPeriodStart(now: Date, resetDay: number, resetHour: number): Date {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const thisMonth = resetPointOf(y, m, resetDay, resetHour);
    return thisMonth.getTime() <= now.getTime() ? thisMonth : resetPointOf(y, m - 1, resetDay, resetHour);
}

/** Next reset time. */
export function nextResetAt(now: Date, resetDay: number, resetHour: number): Date {
    const start = currentPeriodStart(now, resetDay, resetHour);
    return resetPointOf(start.getUTCFullYear(), start.getUTCMonth() + 1, resetDay, resetHour);
}

function makeResetSchedule(now: Date, resetDay: number, resetHour: number): NonNullable<UsagePeriod['resetSchedule']> {
    return { day: resetDay, hour: resetHour, nextResetAt: nextResetAt(now, resetDay, resetHour).toISOString() };
}

function resetIfDue(period: UsagePeriod, now: Date): UsagePeriod {
    const schedule = period.resetSchedule;
    const resetTime = schedule ? Date.parse(schedule.nextResetAt) : Number.NaN;
    if (!schedule || !Number.isFinite(resetTime) || now.getTime() < resetTime) {
        return period;
    }
    return {
        periodStart: currentPeriodStart(now, schedule.day, schedule.hour).toISOString(),
        resetSchedule: makeResetSchedule(now, schedule.day, schedule.hour),
        models: {},
    };
}

/** Total input includes cache reads and writes; optional fields support usage saved before cache tracking. */
export function totalInputTokens(usage: {
    readonly inputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}): number {
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * Whether long-context prices apply to a request. Total input (uncached + cache read + cache write, per AWS prompt-caching docs)
 * is compared with the threshold; the model cards only say "more than 272K input tokens".
 */
export function isLongContext(usage: TokenUsage, threshold: number | undefined): boolean {
    return threshold !== undefined && totalInputTokens(usage) > threshold;
}

function addCounts(prev: Partial<UsageCounts> | undefined, usage: TokenUsage): UsageCounts {
    return {
        inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: (prev?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
        cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
        requests: (prev?.requests ?? 0) + 1,
    };
}

/** Adds one request's token and request totals to the current period (pure function for easier testing). */
export function addUsage(period: UsagePeriod, invokeId: string, info: ModelInfo, usage: TokenUsage, longContext = false): UsagePeriod {
    const prev = period.models[invokeId];
    return {
        ...period,
        models: {
            ...period.models,
            [invokeId]: {
                ...info,
                ...addCounts(prev, usage),
                ...(longContext ? { longContext: addCounts(prev?.longContext, usage) } : prev?.longContext ? { longContext: prev.longContext } : {}),
            },
        },
    };
}

/**
 * Stores current-period totals per AWS profile in shared storage and only reads `globalState` for legacy migration.
 */
export class UsageStore implements vscode.Disposable {
    private readonly queues = new Map<string, Promise<void>>();

    constructor(
        private readonly memento: vscode.Memento,
        private readonly sharedBacking?: SharedUsageBacking,
    ) { }

    dispose(): void {
        this.sharedBacking?.dispose();
    }

    private key(profile: string): string {
        return `usage:${profile}`;
    }

    private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const current = previous.then(operation);
        const settled = current.then(() => undefined, () => undefined);
        this.queues.set(key, settled);
        void settled.then(() => {
            if (this.queues.get(key) === settled) {
                this.queues.delete(key);
            }
        });
        return current;
    }

    private normalizePeriod(stored: UsagePeriod | undefined, resetDay: number, resetHour: number, now: Date): UsagePeriod {
        if (!stored) {
            return {
                periodStart: currentPeriodStart(now, resetDay, resetHour).toISOString(),
                resetSchedule: makeResetSchedule(now, resetDay, resetHour),
                models: {},
            };
        }
        if (!stored.resetSchedule) {
            return { ...stored, resetSchedule: makeResetSchedule(now, resetDay, resetHour) };
        }
        if (stored.resetSchedule.day !== resetDay || stored.resetSchedule.hour !== resetHour) {
            return stored;
        }
        return resetIfDue(stored, now);
    }

    private migrateLegacyCandidate(profile: string, resetDay: number, resetHour: number, now: Date): UsagePeriod | undefined {
        if (this.memento.get<boolean>(migrationMarkerKey(profile))) {
            return undefined;
        }
        const legacy = this.memento.get<UsagePeriod>(this.key(profile));
        if (!legacy) {
            return undefined;
        }
        const normalized = this.normalizePeriod(legacy, resetDay, resetHour, now);
        return Object.keys(normalized.models).length > 0 ? normalized : undefined;
    }

    get(profile: string, resetDay: number, resetHour: number, now = new Date()): UsagePeriod {
        const shared = this.sharedBacking?.readProfile(profile);
        const legacy = this.sharedBacking && !shared ? this.migrateLegacyCandidate(profile, resetDay, resetHour, now) : undefined;
        return this.normalizePeriod(shared ?? legacy, resetDay, resetHour, now);
    }

    private applyScheduleToPeriod(stored: UsagePeriod | undefined, resetDay: number, resetHour: number, now: Date): UsagePeriod | undefined {
        if (!stored) {
            return undefined;
        }
        const current = resetIfDue(stored, now);
        const schedule = current.resetSchedule;
        if (schedule?.day === resetDay && schedule.hour === resetHour) {
            return current;
        }
        return {
            ...current,
            resetSchedule: makeResetSchedule(now, resetDay, resetHour),
        };
    }

    /** Saves the next reset point for a changed schedule without clearing current totals, and migrates legacy globalState if needed. */
    configureResetSchedule(profile: string, resetDay: number, resetHour: number, now = new Date()): Promise<void> {
        const key = this.key(profile);
        return this.serialize(key, async () => {
            const backing = this.sharedBacking;
            if (!backing) return;
            const legacyCandidate = this.migrateLegacyCandidate(profile, resetDay, resetHour, now);
            const existing = backing.readProfile(profile);
            if (!existing && !legacyCandidate) {
                if (!this.memento.get<boolean>(migrationMarkerKey(profile))) {
                    await this.memento.update(migrationMarkerKey(profile), true);
                }
                return;
            }
            let migrated = false;
            await backing.writeProfile(profile, (current) => {
                const seed = current ?? legacyCandidate;
                if (!current && legacyCandidate) {
                    migrated = true;
                }
                return this.applyScheduleToPeriod(seed, resetDay, resetHour, now) ?? this.normalizePeriod(undefined, resetDay, resetHour, now);
            });
            if (migrated || !this.memento.get<boolean>(migrationMarkerKey(profile))) {
                await this.memento.update(migrationMarkerKey(profile), true);
            }
        });
    }

    async record(
        profile: string,
        invokeId: string,
        info: ModelInfo,
        usage: TokenUsage,
        resetDay: number,
        resetHour: number,
        now = new Date(),
        longContext = false,
    ): Promise<void> {
        const key = this.key(profile);
        return this.serialize(key, async () => {
            const backing = this.sharedBacking;
            if (!backing) return;
            const legacyCandidate = this.migrateLegacyCandidate(profile, resetDay, resetHour, now);
            await backing.writeProfile(profile, (current) => {
                const seeded = current ?? legacyCandidate;
                const scheduled = this.applyScheduleToPeriod(seeded, resetDay, resetHour, now);
                const basePeriod = this.normalizePeriod(scheduled, resetDay, resetHour, now);
                return addUsage(basePeriod, invokeId, info, usage, longContext);
            });
            if (!this.memento.get<boolean>(migrationMarkerKey(profile))) {
                await this.memento.update(migrationMarkerKey(profile), true);
            }
        });
    }

    /** Manual reset: clear current-period totals without changing the period start. */
    reset(profile: string, resetDay: number, resetHour: number, now = new Date()): Promise<void> {
        const key = this.key(profile);
        return this.serialize(key, async () => {
            const backing = this.sharedBacking;
            if (!backing) throw new Error('Shared usage storage is unavailable.');
            await backing.writeProfile(profile, (current) => {
                const scheduled = this.applyScheduleToPeriod(current, resetDay, resetHour, now);
                const period = this.normalizePeriod(scheduled, resetDay, resetHour, now);
                return { ...period, manualResetAt: now.toISOString(), models: {} };
            });
            if (!this.memento.get<boolean>(migrationMarkerKey(profile))) {
                await this.memento.update(migrationMarkerKey(profile), true);
            }
        });
    }
}
