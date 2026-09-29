import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AmazonBedrockProvider } from '../src/provider';
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
        });
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