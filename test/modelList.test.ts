import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    send: vi.fn(),
    destroy: vi.fn(),
    fromIni: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock', () => ({
    BedrockClient: class {
        config = { region: async () => 'us-west-2' };
        send = mocks.send;
        destroy = mocks.destroy;
    },
    ListFoundationModelsCommand: class {
        constructor(readonly input: unknown) { }
    },
    ListInferenceProfilesCommand: class {
        constructor(readonly input: unknown) { }
    },
}));
vi.mock('@aws-sdk/credential-providers', () => ({ fromIni: mocks.fromIni }));

import { fetchModelSources } from '../src/modelList';

beforeEach(() => {
    vi.resetAllMocks();
    mocks.fromIni.mockReturnValue({});
});

describe('fetchModelSources', () => {
    it('paginates inference profiles and normalizes both source responses', async () => {
        mocks.send
            .mockResolvedValueOnce({
                inferenceProfileSummaries: [
                    { inferenceProfileId: 'us.anthropic.claude-test', inferenceProfileName: 'US Claude', status: 'ACTIVE' },
                    { inferenceProfileId: 'global.openai.gpt-test', status: 'INACTIVE' },
                    { status: 'ACTIVE' },
                ],
                nextToken: 'next-page',
            })
            .mockResolvedValueOnce({ inferenceProfileSummaries: [{ inferenceProfileId: 'eu.vendor.model', status: 'ACTIVE' }] })
            .mockResolvedValueOnce({
                modelSummaries: [
                    {
                        modelId: 'anthropic.claude-test',
                        modelName: 'Claude Test',
                        outputModalities: ['TEXT'],
                        responseStreamingSupported: true,
                        inferenceTypesSupported: ['ON_DEMAND'],
                        inputModalities: ['TEXT', 'IMAGE'],
                    },
                    { modelId: 'vendor.model' },
                    { modelName: 'missing-id' },
                ]
            });

        await expect(fetchModelSources('dev-profile', 'us-west-2')).resolves.toEqual({
            region: 'us-west-2',
            foundationsDenied: false,
            profiles: [
                { id: 'us.anthropic.claude-test', name: 'US Claude', active: true },
                { id: 'global.openai.gpt-test', name: 'global.openai.gpt-test', active: false },
                { id: 'eu.vendor.model', name: 'eu.vendor.model', active: true },
            ],
            foundations: [
                { id: 'anthropic.claude-test', name: 'Claude Test', textOutput: true, streaming: true, onDemand: true, imageInput: true },
                { id: 'vendor.model', name: 'vendor.model', textOutput: false, streaming: false, onDemand: false, imageInput: false },
            ],
        });

        expect(mocks.send).toHaveBeenCalledTimes(3);
        expect(mocks.send.mock.calls.map(([command]) => command.input)).toEqual([
            { typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken: undefined },
            { typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken: 'next-page' },
            {},
        ]);
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });

    it('returns profile-only results by default when foundation-model listing is denied', async () => {
        mocks.send
            .mockResolvedValueOnce({ inferenceProfileSummaries: [{ inferenceProfileId: 'us.vendor.model', status: 'ACTIVE' }] })
            .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

        await expect(fetchModelSources('dev-profile', 'us-west-2')).resolves.toMatchObject({
            profiles: [{ id: 'us.vendor.model', active: true }],
            foundations: [],
            foundationsDenied: true,
        });
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });

    it('throws a contextual error when a caller requires foundation models', async () => {
        mocks.send
            .mockResolvedValueOnce({ inferenceProfileSummaries: [] })
            .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

        await expect(fetchModelSources('dev-profile', 'us-west-2', { onFoundationModelsAccessDenied: 'throw' }))
            .rejects.toMatchObject({ name: 'AccessDeniedException', operation: 'ListFoundationModels', region: 'us-west-2' });
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });

    it('destroys the client when profile listing fails', async () => {
        mocks.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

        await expect(fetchModelSources('dev-profile', 'us-west-2'))
            .rejects.toMatchObject({ name: 'AccessDeniedException', operation: 'ListInferenceProfiles', region: 'us-west-2' });
        expect(mocks.destroy).toHaveBeenCalledOnce();
    });
});