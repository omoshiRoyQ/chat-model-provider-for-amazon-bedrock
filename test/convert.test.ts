import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildToolConfig, toConverseMessages } from '../src/convert';

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
