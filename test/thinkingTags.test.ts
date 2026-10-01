import { describe, expect, it } from 'vitest';
import { ThinkingTagFilter } from '../src/thinkingTags';

/**
 * Behavior source: AWS Nova docs (tool-use-invocation) say Nova wraps tool-calling chain-of-thought in <thinking> tags,
 * possibly several blocks per response. RESPONSE is Nova Lite's actual reply to "1+1=?" with one tool defined (2026-10-01).
 */
const RESPONSE = '<thinking>The User is asking a simple arithmetic question. I do not need to use any tools to answer this question.</thinking>\n\nThe answer is 2.';

function run(chunks: string[]): { text: string; removed: number } {
    const filter = new ThinkingTagFilter();
    const text = chunks.map((c) => filter.push(c)).join('') + filter.flush();
    return { text, removed: filter.removed };
}

describe('ThinkingTagFilter', () => {
    it('removes the thinking block from a whole response', () => {
        expect(run([RESPONSE]).text).toBe('\n\nThe answer is 2.');
    });

    it('handles tags split across every possible chunk boundary', () => {
        for (let i = 1; i < RESPONSE.length; i++) {
            expect(run([RESPONSE.slice(0, i), RESPONSE.slice(i)]).text).toBe('\n\nThe answer is 2.');
        }
    });

    it('removes several blocks and keeps text between them', () => {
        expect(run(['A<thinking>x</thinking>B<think', 'ing>y</thinking>C']).text).toBe('ABC');
    });

    it('unwraps <response> tags at any chunk boundary (Nova output reported by the user in Chat on 2026-10-01)', () => {
        const reply = '<thinking>simple math</thinking>\n<response>The result of 1+1 is 2.</response>';
        for (let i = 1; i < reply.length; i++) {
            expect(run([reply.slice(0, i), reply.slice(i)]).text).toBe('\nThe result of 1+1 is 2.');
        }
    });

    it('unwraps <answer> tags (Nova Lite output reported by the user in Chat on 2026-10-01)', () => {
        expect(run(['<answer> The result of 1+1 is 2. </answer>']).text).toBe(' The result of 1+1 is 2. ');
    });

    it('keeps text that only looks like the start of a tag', () => {
        expect(run(['a <think', 'er> b']).text).toBe('a <thinker> b');
        expect(run(['ends with <']).text).toBe('ends with <');
    });

    it('drops an unclosed block at the end and counts removed characters', () => {
        expect(run(['ok<thinking>cut off']).text).toBe('ok');
        expect(run(['ok<thinking>cut off']).removed).toBe('cut off'.length);
    });
});
