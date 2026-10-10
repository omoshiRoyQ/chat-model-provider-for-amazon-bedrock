import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AmazonBedrockProvider } from '../src/provider';
import type { ModelCardStore } from '../src/modelCardStore';
import type { ResolvedModel } from '../src/models';
import type { SsoSignIn } from '../src/signIn';
import type { SignInStatusBar } from '../src/statusBar';

const mocks = vi.hoisted(() => ({
    stream: vi.fn(),
    readSettings: vi.fn(),
}));

vi.mock('../src/native', () => ({
    NativeConverseClient: class {
        stream = mocks.stream;
        constructor(_log: unknown) { }
    },
}));

vi.mock('../src/settings', () => ({
    CONFIG_SECTION: 'amazonBedrockProvider',
    readSettings: mocks.readSettings,
}));

const settings = (profile: string) => ({
    profile,
    region: 'us-west-2',
    modelFilter: 'claudeAndGpt' as const,
    inferenceScope: 'geo' as const,
    usageResetDay: 1,
    usageResetHour: 0,
    customPricing: {},
});

/** Expected behavior comes from the user's profile-attribution rule: usage is attributed to the profile active when the request starts. */
describe('AmazonBedrockProvider usage attribution', () => {
    it('reports usage against the profile used when the request started', async () => {
        const profileAtStart = 'profile-a';
        const usage = { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
        let finishRequest!: (value: typeof usage) => void;
        mocks.readSettings.mockReturnValue(settings(profileAtStart));
        mocks.stream.mockReturnValue(new Promise((resolve) => {
            finishRequest = resolve;
        }));

        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel;
        const signInBar = { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar;
        const onUsage = vi.fn();
        const provider = new AmazonBedrockProvider(log, signInBar, {} as SsoSignIn, {
            thinkingEffort: () => 'default',
            onUsage,
        }, {} as ModelCardStore);
        const model = {
            id: 'us.anthropic.test-model',
            name: 'Test Model',
            maxOutputTokens: 4_096,
            capabilities: { imageInput: false },
        } as vscode.LanguageModelChatInformation;
        const request = provider.provideLanguageModelChatResponse(
            model,
            [],
            { tools: undefined, toolMode: vscode.LanguageModelChatToolMode.Auto },
            { report: vi.fn() },
            { isCancellationRequested: false } as vscode.CancellationToken,
        );

        mocks.readSettings.mockReturnValue(settings('profile-b'));
        finishRequest(usage);
        await request;

        expect(onUsage).toHaveBeenCalledWith(profileAtStart, undefined, model.id, model.name, usage);
        provider.dispose();
    });
});

/** The rejection message was observed from Mistral 7B Instruct on 2026-10-01; resending as user text is the user's decision. */
describe('AmazonBedrockProvider system messages', () => {
    it('resends with the system prompt as user text when the model rejects system messages, then skips the field', async () => {
        mocks.readSettings.mockReturnValue(settings('dev'));
        const rejection = Object.assign(new Error("This model doesn't support system messages. Try again without a system message or use a model that supports system messages."), { name: 'ValidationException' });
        mocks.stream.mockReset();
        mocks.stream.mockRejectedValueOnce(rejection).mockResolvedValue(undefined);

        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel;
        const signInBar = { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar;
        const provider = new AmazonBedrockProvider(log, signInBar, {} as SsoSignIn, { thinkingEffort: () => 'default', onUsage: vi.fn() }, {} as ModelCardStore);
        const model = { id: 'mistral.mistral-7b-instruct-v0:2', name: 'Mistral 7B', maxOutputTokens: 4_096, capabilities: {} } as vscode.LanguageModelChatInformation;
        const messages = [
            { role: 3 as vscode.LanguageModelChatMessageRole, content: [new vscode.LanguageModelTextPart('Be brief.')], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('1+1=?')], name: undefined },
        ];
        const send = () => provider.provideLanguageModelChatResponse(
            model,
            messages,
            { tools: undefined, toolMode: vscode.LanguageModelChatToolMode.Auto },
            { report: vi.fn() },
            { isCancellationRequested: false } as vscode.CancellationToken,
        );

        await send();
        await send();

        const requests = mocks.stream.mock.calls.map((c) => c[0]);
        expect(requests[0]).toMatchObject({ system: [{ text: 'Be brief.' }], messages: [{ role: 'user', content: [{ text: '1+1=?' }] }] });
        const asUser = { system: undefined, messages: [{ role: 'user', content: [{ text: 'Be brief.' }, { text: '1+1=?' }] }] };
        expect(requests[1]).toMatchObject(asUser);
        expect(requests[2]).toMatchObject(asUser);
        expect(requests).toHaveLength(3);
        provider.dispose();
    });
});

/** Cache placement is the user's design (2026-10-03); models are flagged from the AWS prompt-caching.html supported list. */
describe('AmazonBedrockProvider prompt cache', () => {
    const send = async (promptCache: boolean) => {
        mocks.readSettings.mockReturnValue(settings('dev'));
        mocks.stream.mockReset();
        mocks.stream.mockResolvedValue(undefined);
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel;
        const signInBar = { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar;
        const provider = new AmazonBedrockProvider(log, signInBar, {} as SsoSignIn, { thinkingEffort: () => 'default', onUsage: vi.fn() }, {} as ModelCardStore);
        const id = 'us.anthropic.claude-sonnet-5-5';
        const resolved: ResolvedModel = { invokeId: id, baseId: 'anthropic.claude-sonnet-5-5', name: 'Claude Sonnet 5.5', route: 'Geo', contextWindow: 1_000_000, maxOutputTokens: 128_000, maxOutputSourced: true, thinking: 'none', imageInput: true, promptCache };
        (provider as unknown as { modelsById: Map<string, ResolvedModel> }).modelsById = new Map([[id, resolved]]);
        const model = { id, name: resolved.name, maxOutputTokens: 128_000, capabilities: {} } as vscode.LanguageModelChatInformation;
        const messages = [
            { role: 3 as vscode.LanguageModelChatMessageRole, content: [new vscode.LanguageModelTextPart('Be brief.')], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('1+1=?')], name: undefined },
        ];
        const tool: vscode.LanguageModelChatTool = { name: 'read_file', description: 'read', inputSchema: undefined };
        await provider.provideLanguageModelChatResponse(model, messages, { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: vi.fn() }, { isCancellationRequested: false } as vscode.CancellationToken);
        provider.dispose();
        return mocks.stream.mock.calls[0][0];
    };

    it('promptCache 模型在 tools、system、最後一則 message 結尾加 cachePoint', async () => {
        const request = await send(true);
        const cachePoint = { cachePoint: { type: 'default' } };
        expect(request.toolConfig.tools.at(-1)).toEqual(cachePoint);
        expect(request.system).toEqual([{ text: 'Be brief.' }, cachePoint]);
        expect(request.messages.at(-1).content).toEqual([{ text: '1+1=?' }, cachePoint]);
    });

    it('沒有 promptCache 的模型不加 cachePoint', async () => {
        expect(JSON.stringify(await send(false))).not.toContain('cachePoint');
    });
});

/** Expected 128,000-token limit comes from the AWS Claude Haiku 5.5 model card recorded in src/models.ts. */
describe('AmazonBedrockProvider output token limit', () => {
    it('passes the catalog limit to Converse when thinking effort is default', async () => {
        mocks.readSettings.mockReturnValue({
            ...settings(process.env.AWS_PROFILE ?? ''),
            region: process.env.AWS_REGION ?? '',
        });
        mocks.stream.mockReset().mockResolvedValue(undefined);

        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel;
        const provider = new AmazonBedrockProvider(log, { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar, {} as SsoSignIn, {
            thinkingEffort: () => 'default',
            onUsage: vi.fn(),
        }, {} as ModelCardStore);
        const modelId = 'us.anthropic.claude-haiku-5-5';
        const resolved: ResolvedModel = {
            invokeId: modelId,
            baseId: 'anthropic.claude-haiku-5-5',
            name: 'Claude Haiku 5.5',
            route: 'Geo',
            contextWindow: 1_000_000,
            maxOutputTokens: 128_000,
            maxOutputSourced: true,
            thinking: 'adaptive',
            imageInput: false,
            promptCache: true,
            longContextThreshold: 100_000,
        };
        (provider as unknown as { modelsById: Map<string, ResolvedModel> }).modelsById = new Map([[modelId, resolved]]);
        const model = {
            id: modelId,
            name: resolved.name,
            maxOutputTokens: resolved.maxOutputTokens,
            capabilities: { imageInput: false },
        } as vscode.LanguageModelChatInformation;

        try {
            await provider.provideLanguageModelChatResponse(
                model,
                [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Reply briefly.')], name: undefined }],
                { tools: undefined, toolMode: vscode.LanguageModelChatToolMode.Auto },
                { report: vi.fn() },
                { isCancellationRequested: false } as vscode.CancellationToken,
            );

            expect(mocks.stream.mock.calls[0][0].maxTokens).toBe(resolved.maxOutputTokens);
        } finally {
            provider.dispose();
        }
    });

    it('omits maxTokens when the limit is only the conservative fallback', async () => {
        mocks.readSettings.mockReturnValue(settings('dev'));
        mocks.stream.mockReset().mockResolvedValue(undefined);
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel;
        const provider = new AmazonBedrockProvider(log, { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar, {} as SsoSignIn, {
            thinkingEffort: () => 'default',
            onUsage: vi.fn(),
        }, {} as ModelCardStore);
        const modelId = 'us.anthropic.claude-3-sonnet-20240229-v1:0';
        const resolved: ResolvedModel = {
            invokeId: modelId,
            baseId: 'anthropic.claude-3-sonnet-20240229-v1:0',
            name: 'Claude 3 Sonnet',
            route: 'Geo',
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            maxOutputSourced: false,
            thinking: 'none',
            imageInput: true,
            promptCache: false,
        };
        (provider as unknown as { modelsById: Map<string, ResolvedModel> }).modelsById = new Map([[modelId, resolved]]);
        const model = { id: modelId, name: resolved.name, maxOutputTokens: 4_096, capabilities: {} } as vscode.LanguageModelChatInformation;

        try {
            await provider.provideLanguageModelChatResponse(
                model,
                [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('Reply briefly.')], name: undefined }],
                { tools: undefined, toolMode: vscode.LanguageModelChatToolMode.Auto },
                { report: vi.fn() },
                { isCancellationRequested: false } as vscode.CancellationToken,
            );

            expect(mocks.stream.mock.calls[0][0].maxTokens).toBeUndefined();
        } finally {
            provider.dispose();
        }
    });
});