import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AmazonBedrockProvider, type ProviderHooks } from '../src/provider';
import type { ModelCardStore } from '../src/modelCardStore';
import type { ResolvedModel } from '../src/models';
import type { SsoSignIn } from '../src/signIn';
import type { SignInStatusBar } from '../src/statusBar';
import { parseModelVisibility } from '../src/modelFilter';
import type { BedrockSettings } from '../src/settings';

const mocks = vi.hoisted(() => ({
    stream: vi.fn(),
    readSettings: vi.fn(),
    fetchModelSources: vi.fn(),
}));

vi.mock('../src/native', () => ({
    NativeConverseClient: class {
        stream = mocks.stream;
        constructor(_log: unknown) { }
    },
}));

vi.mock('../src/modelList', () => ({
    fetchModelSources: mocks.fetchModelSources,
}));

vi.mock('../src/settings', () => ({
    CONFIG_SECTION: 'amazonBedrockProvider',
    readSettings: mocks.readSettings,
}));

const settings = (profile: string): BedrockSettings => ({
    profile,
    region: 'us-west-2',
    modelVisibility: parseModelVisibility({ mode: 'selected', providers: ['anthropic', 'openai'] }),
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

/** Expected behavior comes from the user's report: after the SSO token expires mid-session, the sign-in button must stay until a real AWS call succeeds. */
describe('AmazonBedrockProvider sign-in button', () => {
    it('stays visible when VS Code re-queries a cached model list after a credential failure', async () => {
        mocks.readSettings.mockReturnValue(settings('dev'));
        mocks.fetchModelSources.mockReset().mockResolvedValue({ region: 'us-west-2', profiles: [], foundations: [], foundationsDenied: false });
        mocks.stream.mockReset().mockRejectedValue(Object.assign(new Error('Token is expired.'), { name: 'CredentialsProviderError' }));
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel;
        const show = vi.fn();
        const hide = vi.fn();
        const modelCards = { limits: () => new Map(), needsRefresh: () => false } as unknown as ModelCardStore;
        const provider = new AmazonBedrockProvider(log, { show, hide } as unknown as SignInStatusBar, {} as SsoSignIn, {
            thinkingEffort: () => 'default',
            onUsage: vi.fn(),
        }, modelCards);
        const model = { id: 'us.anthropic.test-model', name: 'Test Model', maxOutputTokens: 4_096, capabilities: { imageInput: false } } as vscode.LanguageModelChatInformation;
        try {
            await provider.provideLanguageModelChatInformation({ silent: true }, {} as vscode.CancellationToken);
            await expect(provider.provideLanguageModelChatResponse(
                model,
                [],
                { tools: undefined, toolMode: vscode.LanguageModelChatToolMode.Auto },
                { report: vi.fn() },
                { isCancellationRequested: false } as vscode.CancellationToken,
            )).rejects.toThrow();
            expect(show).toHaveBeenCalledTimes(1);
            hide.mockClear();

            await provider.provideLanguageModelChatInformation({ silent: true }, {} as vscode.CancellationToken);

            expect(mocks.fetchModelSources).toHaveBeenCalledTimes(1);
            expect(hide).not.toHaveBeenCalled();
            mocks.readSettings.mockReturnValue({ ...settings('dev'), modelVisibility: parseModelVisibility({ mode: 'selected', providers: ['nvidia'] }) });
            await provider.provideLanguageModelChatInformation({ silent: true }, {} as vscode.CancellationToken);
            expect(mocks.fetchModelSources).toHaveBeenCalledTimes(1);
            expect(hide).not.toHaveBeenCalled();
        } finally {
            provider.dispose();
        }
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

/** Source: confirmed provider/version/unknown/cache rules. All AWS, credential and card requests below are substitutes. */
describe('AmazonBedrockProvider model visibility', () => {
    const bases = ['openai.gpt-5.6-luna', 'openai.gpt-6-luna', 'openai.gpt-6.1-sol', 'openai.gpt-next', 'openai.gpt-oss-20b-1:0', 'nvidia.nemotron-nano-12b-v2', 'xai.grok-4.6', 'xai.grok-4.7', 'moonshotai.kimi-k3'];
    const sources = (ids = bases) => ({ region: '<region>', foundationsDenied: true, foundations: [], profiles: ids.map((id) => ({ id: `us.${id}`, name: `US Renamed ${id}`, active: true })) });
    let active: BedrockSettings;
    let provider: AmazonBedrockProvider;
    let listener: (event: vscode.ConfigurationChangeEvent) => unknown;
    let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    let cards: { limits: ReturnType<typeof vi.fn>; needsRefresh: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };
    let notify: ReturnType<typeof vi.spyOn>;
    const list = () => provider.provideLanguageModelChatInformation({ silent: true }, {} as vscode.CancellationToken);
    const choose = (providers: string[], minimumVersions = {}) => {
        active = { ...active, modelVisibility: parseModelVisibility({ mode: 'selected', providers, minimumVersions }) };
    };
    const changed = () => listener({ affectsConfiguration: (section) => section === 'amazonBedrockProvider' } as vscode.ConfigurationChangeEvent);
    beforeEach(() => {
        active = { ...settings('<profile>'), region: '<region>' };
        mocks.readSettings.mockImplementation(() => active);
        mocks.fetchModelSources.mockReset().mockResolvedValue(sources());
        mocks.stream.mockReset().mockResolvedValue(undefined);
        vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation((callback) => { listener = callback; return { dispose() { } }; });
        notify = vi.spyOn(vscode.EventEmitter.prototype, 'fire');
        log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        cards = { limits: vi.fn(() => new Map()), needsRefresh: vi.fn(() => false), refresh: vi.fn(async () => ({ fetched: 0, failed: [] })) };
        provider = new AmazonBedrockProvider(log as unknown as vscode.LogOutputChannel, { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar, {} as SsoSignIn, { thinkingEffort: () => 'default', onUsage: vi.fn() }, cards as unknown as ModelCardStore);
    });
    afterEach(() => { provider.dispose(); vi.restoreAllMocks(); });
    it('new selection supersedes legacy default and recomposes without another source request', async () => {
        expect((await list()).some((m) => m.id.includes('nvidia.'))).toBe(false);
        choose(['nvidia']); changed();
        expect((await list()).map((m) => m.id)).toEqual(['us.nvidia.nemotron-nano-12b-v2']);
        expect(mocks.fetchModelSources).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledOnce();
    });
    it('marks unknown GPT with an active threshold, hides OSS and restores lower versions and OSS when cleared', async () => {
        choose(['openai'], { gpt: '6' });
        let models = await list();
        expect(models.map((m) => m.id)).toEqual(['us.openai.gpt-6-luna', 'us.openai.gpt-6.1-sol', 'us.openai.gpt-next']);
        expect(models.find((m) => m.id.endsWith('gpt-next'))).toMatchObject({ detail: expect.stringContaining('Version unknown'), tooltip: expect.stringContaining('Version unknown') });
        choose(['openai']); changed();
        models = await list();
        expect(models.map((m) => m.id)).toContain('us.openai.gpt-5.6-luna');
        expect(models.map((m) => m.id)).toContain('us.openai.gpt-oss-20b-1:0');
        expect(models.find((m) => m.id.endsWith('gpt-next'))?.detail).toBe('Native · Geo');
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
    it('ignores display names and classifies profiles-only Moonshot aliases', async () => {
        choose(['moonshot']);
        expect((await list()).map((m) => m.id)).toEqual(['us.moonshotai.kimi-k3']);
    });
    it('all includes future providers, while empty/invalid selection yields no models or card refresh', async () => {
        mocks.fetchModelSources.mockResolvedValue(sources(['future.new-model', 'openai.gpt-next']));
        active = { ...active, modelVisibility: parseModelVisibility({ mode: 'all', providers: [] }) };
        expect(await list()).toHaveLength(2);
        cards.needsRefresh.mockReturnValue(true);
        choose([]); changed();
        expect(await list()).toEqual([]);
        active = { ...active, modelVisibility: parseModelVisibility(null) }; changed();
        expect(await list()).toEqual([]);
        expect(log.warn).toHaveBeenCalledWith('modelVisibility must be an object');
        expect(cards.refresh).not.toHaveBeenCalled();
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
    it('does not download cards for providers or generations hidden by visibility', async () => {
        cards.needsRefresh.mockReturnValue(true);
        mocks.fetchModelSources.mockResolvedValue(sources(['openai.gpt-next', 'nvidia.uncataloged']));
        choose(['anthropic']);
        expect(await list()).toEqual([]);
        expect(cards.needsRefresh).not.toHaveBeenCalled();
        expect(cards.refresh).not.toHaveBeenCalled();
    });
    it('uses normalized cache identity and shares simultaneous queries', async () => {
        choose(['openai', 'xai'], { gpt: '6.0' });
        const [first, second] = await Promise.all([list(), list()]);
        expect(first).toEqual(second);
        choose(['xai', 'openai'], { gpt: '6' });
        expect(await list()).toEqual(first);
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
        expect(log.info.mock.calls.filter(([message]) => String(message).startsWith('Loading model list'))).toHaveLength(1);
    });
    it('scope changes select the correct route from the same source query', async () => {
        mocks.fetchModelSources.mockResolvedValue({ ...sources(['openai.gpt-6-luna']), profiles: [...sources(['openai.gpt-6-luna']).profiles, { id: 'global.openai.gpt-6-luna', name: 'Global Renamed', active: true }] });
        expect((await list())[0].id).toBe('us.openai.gpt-6-luna');
        active = { ...active, inferenceScope: 'global' }; changed();
        expect((await list())[0].id).toBe('global.openai.gpt-6-luna');
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
    it('profile/region changes query a new source and older completion cannot replace current metadata', async () => {
        let finish!: (value: ReturnType<typeof sources>) => void;
        mocks.fetchModelSources.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const older = list();
        active = { ...active, profile: '<profile-b>', region: '<region-b>' }; choose(['xai'], { grok: '4.7' }); changed();
        expect((await list()).map((m) => m.id)).toEqual(['us.xai.grok-4.7']);
        finish(sources(['openai.gpt-6-luna']));
        expect(await older).toEqual([]);
        expect(provider.models.map((m) => m.baseId)).toEqual(['xai.grok-4.7']);
        expect(mocks.fetchModelSources).toHaveBeenCalledTimes(2);
    });
    it('a failed source query is retried, not cached', async () => {
        vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        mocks.fetchModelSources.mockRejectedValueOnce(new Error('unit-test failure'));
        expect(await list()).toEqual([]);
        expect(await list()).not.toEqual([]);
        expect(mocks.fetchModelSources).toHaveBeenCalledTimes(2);
    });
    it('deduplicates background refresh callbacks and reuses sources after card updates', async () => {
        let finish!: (value: { fetched: number; failed: string[] }) => void;
        cards.needsRefresh.mockReturnValue(true);
        cards.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        choose(['openai']); await list();
        choose(['nvidia']); changed(); await list();
        expect(cards.refresh).toHaveBeenCalledOnce();
        notify.mockClear();
        cards.needsRefresh.mockReturnValue(false);
        cards.limits.mockReturnValue(new Map([['nvidia.nemotron-nano-12b-v2', { card: 'unit-test card', contextWindow: 128_000, maxOutputTokens: 4_096 }]]));
        finish({ fetched: 1, failed: [] }); await Promise.resolve();
        expect(notify).toHaveBeenCalledOnce();
        await list();
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
    it('does not let an old card refresh invalidate a newly hidden list', async () => {
        let finish!: (value: { fetched: number; failed: string[] }) => void;
        cards.needsRefresh.mockReturnValue(true);
        cards.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        choose(['openai']); await list();
        choose([]); changed(); await list(); notify.mockClear();
        finish({ fetched: 1, failed: [] }); await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();
        expect(provider.models).toEqual([]);
    });
    it('services new visible unknown IDs after a zero-download in-flight result', async () => {
        let finish!: (value: { fetched: number; failed: string[] }) => void;
        const searched = new Set<string>();
        cards.needsRefresh.mockImplementation((ids: string[]) => ids.some((id) => !searched.has(id)));
        cards.refresh.mockImplementationOnce((ids: string[]) => new Promise((resolve) => {
            finish = (value) => { ids.forEach((id) => searched.add(id)); resolve(value); };
        })).mockImplementationOnce(async (ids: string[]) => { ids.forEach((id) => searched.add(id)); return { fetched: 0, failed: [] }; });
        choose(['openai']); await list();
        choose(['nvidia']); changed(); await list();
        finish({ fetched: 0, failed: [] }); await Promise.resolve(); await Promise.resolve();
        expect(cards.refresh.mock.calls.map(([ids]) => ids)).toEqual([['openai.gpt-next'], ['nvidia.nemotron-nano-12b-v2']]);
        expect(cards.refresh).toHaveBeenCalledTimes(2);
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
    it('notifies for visible card removal with fetched=0, not for hidden-only card changes', async () => {
        let finish!: (value: { fetched: number; failed: string[] }) => void;
        const cached = new Map([['openai.gpt-next', { card: 'unit-test card', contextWindow: 128_000, maxOutputTokens: 4_096 }]]);
        cards.limits.mockReturnValue(cached);
        cards.needsRefresh.mockReturnValue(true);
        cards.refresh.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
        choose(['openai']); await list();
        cards.limits.mockReturnValue(new Map());
        finish({ fetched: 0, failed: [] }); await Promise.resolve();
        expect(notify).toHaveBeenCalledOnce();
        await list(); notify.mockClear();
        cards.limits.mockReturnValue(new Map([['nvidia.nemotron-nano-12b-v2', { card: 'hidden card', contextWindow: 128_000, maxOutputTokens: 4_096 }]]));
        finish({ fetched: 1, failed: [] }); await Promise.resolve();
        expect(notify).not.toHaveBeenCalled();
    });
    it('same-key older credential failure cannot override a successful query after sign-in', async () => {
        let rejectOld!: (error: Error) => void;
        mocks.fetchModelSources.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
        const old = list();
        (provider as unknown as { sso: { run: () => Promise<boolean> } }).sso.run = async () => true;
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        await provider.signIn();
        expect(await list()).not.toEqual([]);
        rejectOld(Object.assign(new Error('older token expired'), { name: 'CredentialsProviderError' }));
        expect(await old).toEqual([]);
        expect(log.error).not.toHaveBeenCalled();
        expect((provider as unknown as { credentialProblem: boolean }).credentialProblem).toBe(false);
    });
    it('same-key older source success cannot clear the latest credential failure', async () => {
        let finishOld!: (value: ReturnType<typeof sources>) => void;
        mocks.fetchModelSources.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
        const old = list();
        (provider as unknown as { sso: { run: () => Promise<boolean> } }).sso.run = async () => true;
        vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        await provider.signIn();
        mocks.fetchModelSources.mockRejectedValueOnce(Object.assign(new Error('new token expired'), { name: 'CredentialsProviderError' }));
        expect(await list()).toEqual([]);
        finishOld(sources()); await old;
        expect((provider as unknown as { credentialProblem: boolean }).credentialProblem).toBe(true);
    });
});

/**
 * Expected behavior comes from the user's preset contract (2026-10-24): a preset keeps its stored route, shows only while its base model and
 * route are listed, sends the base model's invoke ID with its fixed effort, and usage is recorded under the base model. No real AWS call.
 */
describe('AmazonBedrockProvider model presets', () => {
    const luna = 'openai.gpt-6-luna';
    const sources = () => ({
        region: '<region>', foundationsDenied: true, foundations: [],
        profiles: [
            { id: `us.${luna}`, name: 'US Luna', active: true },
            { id: `global.${luna}`, name: 'Global Luna', active: true },
            { id: 'us.nvidia.nemotron-nano-12b-v2', name: 'US Nemotron', active: true },
        ],
    });
    const usage = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const preset = (id: string, effort: string, route = 'Geo', modelId = luna) => ({ id, modelId, route, effort });
    let active: BedrockSettings;
    let stored: unknown;
    let provider: AmazonBedrockProvider;
    let listener: (event: vscode.ConfigurationChangeEvent) => unknown;
    let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    let onUsage: ReturnType<typeof vi.fn<ProviderHooks['onUsage']>>;
    let storeEffort: ReturnType<typeof vi.fn<ProviderHooks['thinkingEffort']>>;
    let notify: ReturnType<typeof vi.spyOn>;
    const list = () => provider.provideLanguageModelChatInformation({ silent: true }, {} as vscode.CancellationToken);
    const changed = () => listener({ affectsConfiguration: (section) => section === 'amazonBedrockProvider' } as vscode.ConfigurationChangeEvent);
    const setPresets = (value: unknown) => { stored = value; changed(); };
    const send = (id: string) => provider.provideLanguageModelChatResponse(
        { id, name: id, maxOutputTokens: 100, capabilities: {} } as vscode.LanguageModelChatInformation,
        [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hi')], name: undefined }],
        { tools: undefined, toolMode: vscode.LanguageModelChatToolMode.Auto },
        { report: vi.fn() },
        { isCancellationRequested: false } as vscode.CancellationToken,
    );
    beforeEach(() => {
        active = { ...settings('<profile>'), region: '<region>', modelVisibility: parseModelVisibility({ mode: 'all', providers: [] }) };
        stored = undefined;
        mocks.readSettings.mockImplementation(() => active);
        mocks.fetchModelSources.mockReset().mockImplementation(async () => sources());
        mocks.stream.mockReset().mockResolvedValue(usage);
        vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(() => ({
            get: () => undefined,
            inspect: (key: string) => ({ key, globalValue: stored }),
        }) as unknown as vscode.WorkspaceConfiguration);
        vi.spyOn(vscode.workspace, 'onDidChangeConfiguration').mockImplementation((callback) => { listener = callback; return { dispose() { } }; });
        notify = vi.spyOn(vscode.EventEmitter.prototype, 'fire');
        log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        onUsage = vi.fn<ProviderHooks['onUsage']>();
        // The base model is set to high; a preset must never read or change this store.
        storeEffort = vi.fn<ProviderHooks['thinkingEffort']>(() => 'high');
        provider = new AmazonBedrockProvider(log as unknown as vscode.LogOutputChannel, { show: vi.fn(), hide: vi.fn() } as unknown as SignInStatusBar, {} as SsoSignIn,
            { thinkingEffort: storeEffort, onUsage }, { limits: () => new Map(), needsRefresh: () => false } as unknown as ModelCardStore);
    });
    afterEach(() => { provider.dispose(); vi.restoreAllMocks(); });

    it('lists the original model plus generated-name presets that inherit the base limits, and nothing without presets', async () => {
        expect((await list()).map((m) => m.name)).toEqual(['Nemotron', 'Luna']);
        setPresets([preset('a', 'medium'), preset('b', 'max')]);
        const models = await list();
        const base = models.find((m) => m.id === `us.${luna}`)!;
        expect(models.map((m) => m.name)).toEqual(expect.arrayContaining(['Luna', 'Luna-Medium (Geo)', 'Luna-Max (Geo)']));
        const medium = models.find((m) => m.name === 'Luna-Medium (Geo)')!;
        expect(medium.id).toBe('bedrock-preset:a');
        expect(medium).toMatchObject({ maxInputTokens: base.maxInputTokens, maxOutputTokens: base.maxOutputTokens, family: luna, capabilities: base.capabilities });
        expect(medium.id).not.toBe(base.id);
        expect(mocks.fetchModelSources).toHaveBeenCalledTimes(1);
    });
    it('sends the base invoke ID with each preset effort, in parallel, without reading or writing the effort store', async () => {
        setPresets([preset('a', 'medium'), preset('b', 'max')]);
        await list();
        await Promise.all([send('bedrock-preset:a'), send('bedrock-preset:b')]);
        const requests = mocks.stream.mock.calls.map((c) => c[0]);
        expect(requests.map((r) => r.modelId)).toEqual([`us.${luna}`, `us.${luna}`]);
        expect(requests.map((r) => r.additionalFields)).toEqual([{ reasoning: { effort: 'medium' } }, { reasoning: { effort: 'max' } }]);
        expect(storeEffort).not.toHaveBeenCalled();
        await send(`us.${luna}`);
        expect(mocks.stream.mock.calls[2][0].additionalFields).toEqual({ reasoning: { effort: 'high' } });
        expect(storeEffort).toHaveBeenCalledWith(`us.${luna}`);
    });
    it('records usage under the base model identity and original name, never the preset name or ID', async () => {
        setPresets([preset('a', 'medium'), preset('b', 'max')]);
        await list();
        await send('bedrock-preset:a');
        await send('bedrock-preset:b');
        expect(onUsage).toHaveBeenCalledTimes(2);
        for (const call of onUsage.mock.calls) {
            expect(call[0]).toBe('<profile>');
            expect(call[1]).toMatchObject({ invokeId: `us.${luna}`, baseId: luna, name: 'Luna', route: 'Geo' });
            expect(call.slice(2)).toEqual([`us.${luna}`, 'Luna', usage]);
        }
    });
    it('keeps the stored route: a Geo preset hides under Global scope while a Global preset shows, with the matching invoke ID', async () => {
        setPresets([preset('geo', 'medium', 'Geo'), preset('glob', 'max', 'Global')]);
        expect((await list()).map((m) => m.name)).toEqual(expect.arrayContaining(['Luna-Medium (Geo)']));
        expect((await list()).map((m) => m.name)).not.toContain('Luna-Max (Global)');
        active = { ...active, inferenceScope: 'global' }; changed();
        const names = (await list()).map((m) => m.name);
        expect(names).toContain('Luna-Max (Global)');
        expect(names).not.toContain('Luna-Medium (Geo)');
        await send('bedrock-preset:glob');
        expect(mocks.stream.mock.calls[0][0].modelId).toBe(`global.${luna}`);
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
    it('rejects a hidden or removed preset without calling AWS, naming the stale ID and keeping the setting', async () => {
        setPresets([preset('geo', 'medium', 'Geo')]);
        await list();
        active = { ...active, inferenceScope: 'global' }; changed(); await list();
        await expect(send('bedrock-preset:geo')).rejects.toThrow(/bedrock-preset|geo/);
        setPresets([]); await list();
        await expect(send('bedrock-preset:geo')).rejects.toThrow();
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(onUsage).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('path=Native'));
        // Restoring Geo scope brings the stored preset back without any edit.
        setPresets([preset('geo', 'medium', 'Geo')]);
        active = { ...active, inferenceScope: 'geo' }; changed();
        expect((await list()).map((m) => m.name)).toContain('Luna-Medium (Geo)');
    });
    it('hides presets together with a base model hidden by visibility, and restores them without deleting the setting', async () => {
        setPresets([preset('a', 'medium')]);
        active = { ...active, modelVisibility: parseModelVisibility({ mode: 'selected', providers: ['nvidia'] }) }; changed();
        expect((await list()).map((m) => m.name)).not.toContain('Luna-Medium (Geo)');
        expect(stored).toEqual([preset('a', 'medium')]);
        active = { ...active, modelVisibility: parseModelVisibility({ mode: 'selected', providers: ['openai'], minimumVersions: { gpt: '6' } }) }; changed();
        expect((await list()).map((m) => m.name)).toContain('Luna-Medium (Geo)');
        active = { ...active, modelVisibility: parseModelVisibility({ mode: 'selected', providers: ['openai'], minimumVersions: { gpt: '7' } }) }; changed();
        expect((await list()).map((m) => m.name)).not.toContain('Luna-Medium (Geo)');
    });
    it('ignores invalid and duplicate items with diagnostics, and skips models without configurable thinking', async () => {
        setPresets([preset('ok', 'low'), { id: 'bad', modelId: luna, route: 'Geo', effort: 'extreme' }, preset('n', 'low', 'Geo', 'nvidia.nemotron-nano-12b-v2'), preset('d', 'low')]);
        const names = (await list()).map((m) => m.name);
        // 'ok' and 'd' share model/route/effort, so both are rejected; the invalid item and the thinking=none model never appear.
        expect(names.filter((n) => n.includes('-'))).toEqual([]);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('duplicate model, route and effort'));
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('effort is not a supported thinking effort'));
        setPresets('not an array');
        expect((await list()).map((m) => m.id)).toEqual(expect.not.arrayContaining([expect.stringContaining('bedrock-preset:')]));
        expect(log.warn).toHaveBeenCalledWith('modelPresets must be an array');
    });
    it('a request already started keeps its preset effort and base identity when the preset is changed or removed', async () => {
        setPresets([preset('a', 'medium')]);
        await list();
        let finish!: (value: typeof usage) => void;
        mocks.stream.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const request = send('bedrock-preset:a');
        setPresets([preset('a', 'max')]); await list();
        setPresets([]); await list();
        finish(usage);
        await request;
        expect(mocks.stream.mock.calls[0][0].additionalFields).toEqual({ reasoning: { effort: 'medium' } });
        expect(onUsage).toHaveBeenCalledWith('<profile>', expect.objectContaining({ baseId: luna }), `us.${luna}`, 'Luna', usage);
    });
    it('notifies Chat when presets change and shares one source query across them', async () => {
        await list();
        notify.mockClear();
        setPresets([preset('a', 'medium')]);
        expect(notify).toHaveBeenCalledOnce();
        await list();
        setPresets([preset('a', 'medium'), preset('b', 'max')]);
        expect(notify).toHaveBeenCalledTimes(2);
        expect((await list()).filter((m) => m.id.startsWith('bedrock-preset:'))).toHaveLength(2);
        expect(mocks.fetchModelSources).toHaveBeenCalledOnce();
    });
});