import { describe, expect, it } from 'vitest';
import { parseToolInput } from '../src/native';

/**
 * Expected values come from the user's decision (2026-09-29): parse errors must not include the raw tool input,
 * because it is chat-derived content and README states that logs never contain chat content.
 */

describe('parseToolInput', () => {
    it('JSON 不完整時，錯誤訊息只含 tool 名稱與長度，不含原始內容', () => {
        const raw = '{"filePath":"config.ts","content":"export const DB_PASSWORD = \'hunter2\';';
        const parse = () => parseToolInput(raw, 'create_file');
        expect(parse).toThrow(/^Failed to parse input for tool "create_file": /);
        expect(parse).toThrow(new RegExp(`; length=${raw.length}$`));
        expect(parse).not.toThrow(/hunter2|config\.ts/);
    });

    it('JSON 不是物件時，錯誤訊息同樣不含原始內容', () => {
        expect(() => parseToolInput('"secret-value"', 'run')).toThrow(/length=14$/);
        expect(() => parseToolInput('"secret-value"', 'run')).not.toThrow(/secret-value/);
    });

    it('空字串視為沒有參數的 tool，回傳空物件', () => {
        expect(parseToolInput('  ', 'noop')).toEqual({});
    });
});
