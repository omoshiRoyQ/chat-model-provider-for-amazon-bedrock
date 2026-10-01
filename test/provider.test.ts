import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AmazonBedrockProvider } from '../src/provider';
import type { ModelCardStore } from '../src/modelCardStore';
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
        const usage = { inputTokens: 4, outputTokens: 2 };
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