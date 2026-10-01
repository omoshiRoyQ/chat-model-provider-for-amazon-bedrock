import {
    BedrockClient,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
    type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock';
import { fromIni } from '@aws-sdk/credential-providers';
import { withOperationContext } from './errors';
import type { FoundationSummary, ProfileSummary } from './models';

/**
 * Fetches inference profiles and foundation models with control-plane APIs; neither API incurs a charge.
 * Credentials are provided by `fromIni({ profile })`; no keys are stored.
 */
export async function fetchModelSources(
    profile: string,
    region: string,
): Promise<{ region: string; profiles: ProfileSummary[]; foundations: FoundationSummary[]; foundationsDenied: boolean }> {
    const client = new BedrockClient({
        profile,
        region: region || undefined,
        credentials: fromIni({ profile }),
    });
    try {
        let region: string;
        try {
            region = await client.config.region();
            if (!region) {
                throw new Error('Region is missing');
            }
        } catch (error) {
            throw withOperationContext(error, 'ResolveRegion');
        }

        const summaries: InferenceProfileSummary[] = [];
        let nextToken: string | undefined;
        do {
            let page;
            try {
                page = await client.send(
                    new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken }),
                );
            } catch (error) {
                throw withOperationContext(error, 'ListInferenceProfiles', region);
            }
            summaries.push(...(page.inferenceProfileSummaries ?? []));
            nextToken = page.nextToken;
        } while (nextToken);

        // ListFoundationModels does not paginate. It is optional: without it, models come from inference profiles only.
        let foundation;
        let foundationsDenied = false;
        try {
            foundation = await client.send(new ListFoundationModelsCommand({}));
        } catch (error) {
            if ((error as { name?: string } | undefined)?.name !== 'AccessDeniedException') {
                throw withOperationContext(error, 'ListFoundationModels', region);
            }
            foundationsDenied = true;
        }

        return {
            region,
            foundationsDenied,
            profiles: summaries.flatMap((p) => (p.inferenceProfileId ? [{
                id: p.inferenceProfileId,
                name: p.inferenceProfileName ?? p.inferenceProfileId,
                active: p.status === 'ACTIVE',
            }] : [])),
            foundations: (foundation?.modelSummaries ?? []).flatMap((m) => (m.modelId ? [{
                id: m.modelId,
                name: m.modelName ?? m.modelId,
                textOutput: m.outputModalities?.includes('TEXT') ?? false,
                streaming: m.responseStreamingSupported ?? false,
                onDemand: m.inferenceTypesSupported?.includes('ON_DEMAND') ?? false,
                imageInput: m.inputModalities?.includes('IMAGE') ?? false,
            }] : [])),
        };
    } finally {
        client.destroy();
    }
}
