import type { FoundationSummary, ProfileSummary } from './models';

export interface FetchModelSourcesOptions {
    /** Defaults to returning profiles without foundations; developer tools can request a fatal permission error. */
    readonly onFoundationModelsAccessDenied?: 'return' | 'throw';
    /** Optional HTTP(S) proxy URL used only by this extension. */
    readonly proxyUrl?: string;
}

export interface ModelSources {
    readonly region: string;
    readonly profiles: ProfileSummary[];
    readonly foundations: FoundationSummary[];
    readonly foundationsDenied: boolean;
}

export function fetchModelSources(
    profile: string,
    region: string,
    options?: FetchModelSourcesOptions,
): Promise<ModelSources>;