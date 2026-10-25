import type { FetchModelSourcesOptions, ModelSources } from './modelListCore.mjs' with { 'resolution-mode': 'import' };

export type { FetchModelSourcesOptions, ModelSources };

export function fetchModelSources(
	profile: string,
	region: string,
	options?: FetchModelSourcesOptions,
): Promise<ModelSources> {
	return import('./modelListCore.mjs').then(({ fetchModelSources: fetch }) => fetch(profile, region, options));
}