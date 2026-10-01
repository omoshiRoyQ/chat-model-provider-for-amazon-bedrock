/**
 * Amazon Nova returns chain-of-thought for tool calling as text wrapped in <thinking> tags
 * (https://docs.aws.amazon.com/nova/latest/userguide/tool-use-invocation.html). This filter removes those blocks
 * from streamed text; a tag may be split across chunks, so a possible partial tag is held back until the next chunk.
 * Nova also wrapped its answer in <response> or <answer> tags in Chat (both observed 2026-10-01); those tags are removed
 * and the answer kept. Add a tag here only after seeing it in real output.
 */
const OPEN = '<thinking>';
const CLOSE = '</thinking>';
const ANSWER_WRAPPERS = ['response', 'answer'];
const OUTSIDE_TAGS = [OPEN, ...ANSWER_WRAPPERS.flatMap((name) => [`<${name}>`, `</${name}>`])];

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagLength(text: string, tag: string): number {
    for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
        if (tag.startsWith(text.slice(-n))) {
            return n;
        }
    }
    return 0;
}

export class ThinkingTagFilter {
    private buffer = '';
    private inside = false;
    /** Characters removed so far, for the log. */
    removed = 0;

    push(chunk: string): string {
        this.buffer += chunk;
        let out = '';
        for (; ;) {
            if (this.inside) {
                const end = this.buffer.indexOf(CLOSE);
                if (end < 0) {
                    const keep = partialTagLength(this.buffer, CLOSE);
                    this.removed += this.buffer.length - keep;
                    this.buffer = this.buffer.slice(this.buffer.length - keep);
                    return out;
                }
                this.removed += end;
                this.buffer = this.buffer.slice(end + CLOSE.length);
                this.inside = false;
            } else {
                const hits = OUTSIDE_TAGS.map((tag) => ({ tag, at: this.buffer.indexOf(tag) })).filter((h) => h.at >= 0);
                if (hits.length === 0) {
                    const keep = Math.max(...OUTSIDE_TAGS.map((tag) => partialTagLength(this.buffer, tag)));
                    out += this.buffer.slice(0, this.buffer.length - keep);
                    this.buffer = this.buffer.slice(this.buffer.length - keep);
                    return out;
                }
                const first = hits.reduce((a, b) => (b.at < a.at ? b : a));
                out += this.buffer.slice(0, first.at);
                this.buffer = this.buffer.slice(first.at + first.tag.length);
                this.inside = first.tag === OPEN;
            }
        }
    }

    /** Returns held-back text at the end of the response; an unclosed block is dropped. */
    flush(): string {
        const rest = this.inside ? '' : this.buffer;
        this.removed += this.inside ? this.buffer.length : 0;
        this.buffer = '';
        return rest;
    }
}
