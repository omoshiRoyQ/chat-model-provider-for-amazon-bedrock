import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { addCachePoints, buildToolConfig, toConverseMessages, toConverseSystem } from '../src/convert';

/**
 * Expected values are based on actual Bedrock Converse behavior verified with the SDK on 2026-09-25 and 26; see comments in src/convert.ts.
 */

function makeLog() {
    return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as vscode.LogOutputChannel & {
        warn: ReturnType<typeof vi.fn>;
    };
}

function user(...content: unknown[]): vscode.LanguageModelChatRequestMessage {
    return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined };
}

function assistant(...content: unknown[]): vscode.LanguageModelChatRequestMessage {
    return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined };
}

const text = (value: string) => new vscode.LanguageModelTextPart(value);
const call = (id: string) => new vscode.LanguageModelToolCallPart(id, 'read_file', {});
const result = (id: string, ...content: unknown[]) => new vscode.LanguageModelToolResultPart(id, content);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('toConverseMessages', () => {
    it('平行 tool 呼叫的結果分成多則 user 訊息時，合併成緊接 assistant 的同一則', () => {
        // Verified: Converse rejects results split across two messages (Expected toolResult blocks at messages.N.content).
        const messages = toConverseMessages(
            [user(text('read two files')), assistant(call('a'), call('b')), user(result('a', text('A'))), user(result('b', text('B')))],
            makeLog(),
            true,
        );
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[2].content?.map((b) => b.toolResult?.toolUseId)).toEqual(['a', 'b']);
    });

    it('缺少 tool 結果時補上錯誤說明，並寫 warning', () => {
        const log = makeLog();
        const messages = toConverseMessages([user(text('go')), assistant(call('a'), call('b')), user(result('a', text('A')))], log, true);
        const ids = messages[2].content?.map((b) => b.toolResult?.toolUseId);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
        const filled = messages[2].content?.find((b) => b.toolResult?.toolUseId === 'b');
        expect(filled?.toolResult?.content?.[0].text).toMatch(/cancelled or returned no result/);
        expect(log.warn).toHaveBeenCalledWith('Assistant message 2 has 1 tool call(s) without results; added error results for: b');
    });

    it('assistant 的 tool 呼叫後面沒有 user 訊息時，也會補上一則帶結果的 user 訊息', () => {
        const messages = toConverseMessages([user(text('go')), assistant(call('a'))], makeLog(), true);
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[2].content?.[0].toolResult?.toolUseId).toBe('a');
    });

    it('略過空字串文字；只剩空內容的訊息整則略過', () => {
        const messages = toConverseMessages([user(text('')), user(text('hi'), text(''))], makeLog(), true);
        expect(messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
    });

    it('tool 沒有輸出時，toolResult.content 放一段文字（Converse 不接受空陣列）', () => {
        const messages = toConverseMessages([user(text('go')), assistant(call('a')), user(result('a'))], makeLog(), true);
        expect(messages[2].content?.[0].toolResult?.content).toEqual([{ text: '(no output)' }]);
    });

    it('使用者附加的圖片轉成 image 區塊；非內容用途的 DataPart 略過並寫 warning', () => {
        const log = makeLog();
        const messages = toConverseMessages(
            [user(text('what is this'), vscode.LanguageModelDataPart.image(PNG, 'image/png'), new vscode.LanguageModelDataPart(new Uint8Array([1]), 'cache_control'))],
            log,
            true,
        );
        expect(messages[0].content).toEqual([{ text: 'what is this' }, { image: { format: 'png', source: { bytes: PNG } } }]);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cache_control'));
    });

    it('只有 stateful_marker 時不寫 warning（Copilot 每則舊訊息各附一個，屬雜訊）', () => {
        const log = makeLog();
        const messages = toConverseMessages([user(text('hi'), new vscode.LanguageModelDataPart(new Uint8Array([1]), 'stateful_marker'))], log, true);
        expect(messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('stateful_marker 與未知類型並存時，warning 只列未知類型', () => {
        const log = makeLog();
        toConverseMessages(
            [
                user(text('hi'), new vscode.LanguageModelDataPart(new Uint8Array([1]), 'stateful_marker'), new vscode.LanguageModelDataPart(new Uint8Array([1]), 'cache_control')),
            ],
            log,
            true,
        );
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith('Skipped unsupported message parts: LanguageModelDataPart(cache_control)×1');
    });

    it('Converse 不支援的圖片格式略過', () => {
        const messages = toConverseMessages([user(text('x'), vscode.LanguageModelDataPart.image(PNG, 'image/bmp'))], makeLog(), true);
        expect(messages[0].content).toEqual([{ text: 'x' }]);
    });

    it('tool 回傳的圖片移到 user 訊息最後，原位置改成說明文字', () => {
        // Verified: GPT-6 Astra rejects images in toolResult but accepts them in a user message.
        const messages = toConverseMessages(
            [user(text('open it')), assistant(call('a')), user(result('a', vscode.LanguageModelDataPart.image(PNG, 'image/png')))],
            makeLog(),
            true,
        );
        const blocks = messages[2].content ?? [];
        expect(blocks.map((b) => Object.keys(b)[0])).toEqual(['toolResult', 'text', 'image']);
        expect(blocks[0].toolResult?.content?.[0].image).toBeUndefined();
        expect(blocks[0].toolResult?.content?.[0].text).toMatch(/attached after the tool results/);
    });

    it('模型不支援圖片時，所有圖片改成說明文字', () => {
        const log = makeLog();
        const messages = toConverseMessages(
            [
                user(text('look'), vscode.LanguageModelDataPart.image(PNG, 'image/png')),
                assistant(call('a')),
                user(result('a', vscode.LanguageModelDataPart.image(PNG, 'image/jpeg'))),
            ],
            log,
            false,
        );
        const all = JSON.stringify(messages);
        expect(all).not.toContain('"image"');
        expect(all.match(/does not accept image input/g)).toHaveLength(2);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('2'));
    });
});

describe('system 訊息', () => {
    // Role 3 is what Copilot Chat sent for its instructions (log roles=3:1,1:2 on 2026-10-01).
    const system = (value: string): vscode.LanguageModelChatRequestMessage => ({ role: 3 as vscode.LanguageModelChatMessageRole, content: [text(value)], name: undefined });
    const input = [system('Be brief.'), user(text('1+1=?'))];

    it('預設放進 Converse 的 system 欄位，不混進 user 訊息', () => {
        expect(toConverseSystem(input)).toEqual([{ text: 'Be brief.' }]);
        expect(toConverseMessages(input, makeLog(), true)).toEqual([{ role: 'user', content: [{ text: '1+1=?' }] }]);
    });

    it('systemAsUser 時改成 user 文字（給不支援 system 的模型）', () => {
        expect(toConverseMessages(input, makeLog(), true, true)).toEqual([{ role: 'user', content: [{ text: 'Be brief.' }, { text: '1+1=?' }] }]);
    });

    it('沒有 system 訊息時不帶 system 欄位', () => {
        expect(toConverseSystem([user(text('hi'))])).toBeUndefined();
    });
});

describe('buildToolConfig', () => {
    const tool: vscode.LanguageModelChatTool = { name: 'read_file', description: 'read', inputSchema: undefined };

    it('有 tools 時轉成 toolSpec；inputSchema 省略時補空的 object schema', () => {
        const config = buildToolConfig([tool], vscode.LanguageModelChatToolMode.Auto, []);
        expect(config?.tools?.[0].toolSpec?.inputSchema?.json).toEqual({ type: 'object', properties: {} });
        expect(config?.toolChoice).toBeUndefined();
    });

    it('toolMode Required 對應 Converse 的 toolChoice any', () => {
        const config = buildToolConfig([tool], vscode.LanguageModelChatToolMode.Required, []);
        expect(config?.toolChoice).toEqual({ any: {} });
    });

    it('沒有 tools 但歷史訊息含 toolUse 時，仍要帶 toolConfig（實測否則回 ValidationException）', () => {
        const history = toConverseMessages([user(text('go')), assistant(call('a')), user(result('a', text('A')))], makeLog(), true);
        const config = buildToolConfig(undefined, vscode.LanguageModelChatToolMode.Auto, history);
        expect(config?.tools?.map((t) => t.toolSpec?.name)).toEqual(['read_file']);
        expect(config?.toolChoice).toBeUndefined();
    });

    it('沒有 tools 也沒有 tool 歷史時不帶 toolConfig', () => {
        expect(buildToolConfig(undefined, vscode.LanguageModelChatToolMode.Auto, [{ role: 'user', content: [{ text: 'hi' }] }])).toBeUndefined();
    });
});

/**
 * Placement is the user's design (2026-10-03). AWS prompt-caching.html: cachePoint is allowed in tools, system, and messages,
 * at most 4 per request; omitting ttl uses the 5-minute default.
 */
describe('addCachePoints', () => {
    const cachePoint = { cachePoint: { type: 'default' } };
    const toolSpec = { name: 'read_file', inputSchema: { json: {} } };

    it('在 tools、system、最後一則 message 結尾各加一個 cachePoint，不修改原本的物件', () => {
        const request = {
            modelId: 'm',
            system: [{ text: 'Be brief.' }],
            toolConfig: { tools: [{ toolSpec }], toolChoice: { any: {} } },
            messages: [
                { role: 'user' as const, content: [{ text: 'a' }] },
                { role: 'assistant' as const, content: [{ text: 'b' }] },
                { role: 'user' as const, content: [{ text: 'c' }] },
            ],
        };
        const before = JSON.stringify(request);
        const cached = addCachePoints(request);
        expect(cached.toolConfig).toEqual({ tools: [{ toolSpec }, cachePoint], toolChoice: { any: {} } });
        expect(cached.system).toEqual([{ text: 'Be brief.' }, cachePoint]);
        expect(cached.messages[0]).toEqual({ role: 'user', content: [{ text: 'a' }] });
        expect(cached.messages[2]).toEqual({ role: 'user', content: [{ text: 'c' }, cachePoint] });
        expect(cached.modelId).toBe('m');
        expect(JSON.stringify(cached).match(/cachePoint/g)).toHaveLength(3);
        expect(JSON.stringify(request)).toBe(before);
    });

    it('沒有 tools、system 或 messages 時不加對應的 cachePoint', () => {
        const cached = addCachePoints({ messages: [], system: undefined, toolConfig: undefined });
        expect(cached).toEqual({ messages: [], system: undefined, toolConfig: undefined });
    });
});
