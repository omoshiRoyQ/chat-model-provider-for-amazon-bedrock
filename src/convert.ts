import type {
    ContentBlock,
    ImageBlock,
    ImageFormat,
    Message,
    SystemContentBlock,
    Tool,
    ToolConfiguration,
    ToolResultContentBlock,
    ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import * as vscode from 'vscode';

/**
 * Converts message and tool formats between VS Code and Converse.
 * This module only performs pure transformations and does not call an API, making it easy to unit test.
 */

/**
 * The SDK's arbitrary JSON type (`DocumentType` from `@smithy/types`), inferred from the SDK's own type
 * to avoid directly importing `@smithy/types`, which is not declared in package.json.
 */
export type Document = NonNullable<ToolUseBlock['input']>;

/** Converse requires the top level of a tool's inputSchema to be an object. VS Code allows an omitted schema, so provide an empty object schema. */
const EMPTY_OBJECT_SCHEMA: Document = { type: 'object', properties: {} };

function toConverseTools(tools: readonly vscode.LanguageModelChatTool[]): Tool[] {
    return tools.map((tool) => ({
        toolSpec: {
            name: tool.name,
            description: tool.description,
            // VS Code's inputSchema is a JSON Schema object and is already a valid JSON document.
            inputSchema: { json: (tool.inputSchema ?? EMPTY_OBJECT_SCHEMA) as Document },
        },
    }));
}

/**
 * Builds the Converse toolConfig.
 *
 * - With tools: set toolChoice according to VS Code's toolMode.
 * - Without tools, but with toolUse or toolResult in the history: Converse still requires toolConfig
 *   (verified on 2026-09-25; otherwise it returns ValidationException: "The toolConfig field must be defined
 *   when using toolUse and toolResult content blocks"). Add empty-schema definitions for tool names found in the history
 *   and omit toolChoice so the model can respond with text only.
 * - With neither: return undefined and omit toolConfig.
 */
export function buildToolConfig(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
    toolMode: vscode.LanguageModelChatToolMode,
    messages: readonly Message[],
): ToolConfiguration | undefined {
    if (tools && tools.length > 0) {
        return {
            tools: toConverseTools(tools),
            // Required maps to Converse's any (call at least one tool); Auto is the Converse default and need not be specified.
            toolChoice: toolMode === vscode.LanguageModelChatToolMode.Required ? { any: {} } : undefined,
        };
    }
    const usedNames = collectToolNames(messages);
    if (usedNames.size === 0) {
        return undefined;
    }
    return {
        tools: [...usedNames].map((name) => ({
            toolSpec: { name, description: name, inputSchema: { json: EMPTY_OBJECT_SCHEMA } },
        })),
    };
}

function collectToolNames(messages: readonly Message[]): Set<string> {
    const names = new Set<string>();
    for (const message of messages) {
        for (const block of message.content ?? []) {
            if (block.toolUse?.name) {
                names.add(block.toolUse.name);
            }
        }
    }
    return names;
}

/** No ttl: Bedrock then uses the default 5-minute TTL (prompt-caching.html). */
const CACHE_POINT = { type: 'default' } as const;

/**
 * Returns a copy with a cachePoint at the end of tools, system, and the last message (at most 3; Converse allows 4 per request).
 * Bedrock processes cache points in tools → system → messages order, so each one caches the whole prefix before it.
 * Only call for models that support explicit prompt caching; the input objects are not modified.
 */
export function addCachePoints<T extends { messages: Message[]; system?: SystemContentBlock[]; toolConfig?: ToolConfiguration }>(request: T): T {
    const { messages, system, toolConfig } = request;
    const last = messages[messages.length - 1];
    return {
        ...request,
        toolConfig: toolConfig?.tools?.length ? { ...toolConfig, tools: [...toolConfig.tools, { cachePoint: CACHE_POINT }] } : toolConfig,
        system: system?.length ? [...system, { cachePoint: CACHE_POINT }] : system,
        messages: last ? [...messages.slice(0, -1), { ...last, content: [...(last.content ?? []), { cachePoint: CACHE_POINT }] }] : messages,
    };
}

/**
 * VS Code's System role is only in the proposed languageModelSystem API; Copilot Chat sends its instructions with it
 * (log showed roles=3:1,1:2 on 2026-10-01).
 */
const SYSTEM_ROLE = 3;

const isSystem = (message: vscode.LanguageModelChatRequestMessage) => (message.role as number) === SYSTEM_ROLE;

/** Text of system messages for Converse's `system` field; undefined when there is none. */
export function toConverseSystem(messages: readonly vscode.LanguageModelChatRequestMessage[]): SystemContentBlock[] | undefined {
    const blocks = messages
        .filter(isSystem)
        .flatMap((m) => m.content)
        .flatMap((part) => (part instanceof vscode.LanguageModelTextPart && part.value ? [{ text: part.value }] : []));
    return blocks.length > 0 ? blocks : undefined;
}

/**
 * Converts VS Code messages to Converse format.
 *
 * - System messages are omitted (send them with toConverseSystem) unless `systemAsUser` is set for models that reject
 *   Converse system messages; they are then sent as user text.
 * - Converse requires user and assistant messages to alternate, so adjacent messages with the same role are merged.
 *   Keep this merge: for parallel tool calls, VS Code puts each tool result in a separate user message,
 *   but Converse requires all toolResult blocks in the user message immediately following the assistant message;
 *   otherwise it returns ValidationException: "Expected toolResult blocks at messages.N.content". This was verified
 *   on 2026-09-26: separate messages were rejected, while a merged message succeeded.
 *   The reference extension easytocloud.bedrock-mantle-vscode-chat does not merge them and hits this error after parallel tool calls.
 * - Converse rejects empty text blocks, so empty strings are skipped.
 * - Unsupported parts (such as unsupported image formats or non-content data) are skipped and logged.
 * - Image placement depends on `imageInput`; see arrangeImages.
 */
export function toConverseMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    log: vscode.LogOutputChannel,
    imageInput: boolean,
    systemAsUser = false,
): Message[] {
    const result: Message[] = [];
    const skipped = new Map<string, number>();
    for (const message of messages) {
        if (isSystem(message) && !systemAsUser) {
            continue;
        }
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
        const content: ContentBlock[] = [];
        for (const part of message.content) {
            const block = toContentBlock(part);
            if (block) {
                content.push(block);
            } else if (block === undefined && !isStatefulMarker(part)) {
                const kind = describePart(part);
                skipped.set(kind, (skipped.get(kind) ?? 0) + 1);
            }
        }
        if (content.length === 0) {
            continue;
        }
        const last = result[result.length - 1];
        if (last && last.role === role) {
            last.content = [...(last.content ?? []), ...content];
        } else {
            result.push({ role, content });
        }
    }
    if (skipped.size > 0) {
        const summary = [...skipped].map(([kind, count]) => `${kind}×${count}`).join(', ');
        log.warn(`Skipped unsupported message parts: ${summary}`);
    }
    arrangeImages(result, imageInput, log);
    fillMissingToolResults(result, log);
    return result;
}

const TOOL_IMAGE_MOVED = '[The image returned by this tool is attached after the tool results.]';
const IMAGE_OMITTED = '[Image omitted: this model does not accept image input.]';

/**
 * Repositions images within messages.
 *
 * - Images in tool results are moved to the end of the same user message, with a text placeholder left in their original position.
 *   GPT-6 Astra rejects images inside toolResult (verified on 2026-09-26 with ValidationException:
 *   "This model doesn't support the image field for user messages"), but accepts images in user messages;
 *   Claude Haiku 4.5 accepts both positions. Moving them to user messages gives all models the same path.
 * - When a model does not support image input, all images are replaced with text placeholders. For example, if the model
 *   changes mid-conversation to one without image support, earlier messages may still contain images that Bedrock would reject.
 */
function arrangeImages(messages: Message[], imageInput: boolean, log: vscode.LogOutputChannel): void {
    let omitted = 0;
    for (const message of messages) {
        const moved: ContentBlock[] = [];
        const content: ContentBlock[] = [];
        for (const block of message.content ?? []) {
            if (block.image) {
                if (imageInput) {
                    content.push(block);
                } else {
                    content.push({ text: IMAGE_OMITTED });
                    omitted++;
                }
                continue;
            }
            const toolResult = block.toolResult;
            if (toolResult?.content?.some((c) => c.image)) {
                const results: ToolResultContentBlock[] = toolResult.content.map((c) => {
                    if (!c.image) {
                        return c;
                    }
                    if (!imageInput) {
                        omitted++;
                        return { text: IMAGE_OMITTED };
                    }
                    moved.push({ text: `Image returned by tool call ${toolResult.toolUseId}:` }, { image: c.image });
                    return { text: TOOL_IMAGE_MOVED };
                });
                content.push({ toolResult: { ...toolResult, content: results } });
                continue;
            }
            content.push(block);
        }
        message.content = [...content, ...moved];
    }
    if (omitted > 0) {
        log.warn(`Model does not support image input; replaced ${omitted} image(s) with text placeholders.`);
    }
}

/**
 * Converse requires every assistant toolUse to have a matching toolResult in the immediately following user message;
 * otherwise it returns ValidationException: "Expected toolResult blocks at messages.N.content".
 * If the user cancels midway or a tool is denied, VS Code may return only some results; add error results for the rest.
 */
function fillMissingToolResults(messages: Message[], log: vscode.LogOutputChannel): void {
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role !== 'assistant') {
            continue;
        }
        const toolUseIds = (message.content ?? []).flatMap((b) => (b.toolUse?.toolUseId ? [b.toolUse.toolUseId] : []));
        if (toolUseIds.length === 0) {
            continue;
        }
        let next = messages[i + 1];
        if (!next || next.role !== 'user') {
            next = { role: 'user', content: [] };
            messages.splice(i + 1, 0, next);
        }
        const answered = new Set((next.content ?? []).flatMap((b) => (b.toolResult?.toolUseId ? [b.toolResult.toolUseId] : [])));
        const missing = toolUseIds.filter((id) => !answered.has(id));
        if (missing.length === 0) {
            continue;
        }
        log.warn(`Assistant message ${i + 1} has ${missing.length} tool call(s) without results; added error results for: ${missing.join(', ')}`);
        // Only Claude and Nova support the status field; models such as GPT may reject it, so use text only.
        const filled: ContentBlock[] = missing.map((toolUseId) => ({
            toolResult: { toolUseId, content: [{ text: 'Error: tool call was cancelled or returned no result.' }] },
        }));
        next.content = [...filled, ...(next.content ?? [])];
    }
}

/**
 * Returns a ContentBlock when conversion succeeds, null when intentionally skipped (for example, an empty string),
 * or undefined for an unsupported type.
 */
function toContentBlock(part: unknown): ContentBlock | null | undefined {
    if (part instanceof vscode.LanguageModelTextPart) {
        return part.value.length > 0 ? { text: part.value } : null;
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
        return { toolUse: { toolUseId: part.callId, name: part.name, input: part.input as Document } };
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
        return { toolResult: { toolUseId: part.callId, content: toToolResultContent(part.content) } };
    }
    if (part instanceof vscode.LanguageModelDataPart) {
        const data = fromDataPart(part);
        if (data === undefined) {
            return undefined;
        }
        return 'image' in data ? { image: data.image } : { text: data.text };
    }
    return undefined;
}

/**
 * Converse ImageBlock accepts only png, jpeg, gif, and webp
 * (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ImageBlock.html).
 * Each image must be no larger than 3.75 MB or 8000x8000 px; each request allows at most 20 images
 * (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html);
 * Bedrock validates these limits and includes the model ID and error code in any resulting error.
 */
const IMAGE_FORMATS: Readonly<Record<string, ImageFormat>> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

/**
 * Converts a LanguageModelDataPart.
 * - Images become image blocks.
 * - Text and JSON are decoded as UTF-8 text.
 * - Other MIME types (such as non-content data Copilot uses to mark cache locations or unsupported image formats) return undefined;
 *   the caller skips and logs them. Do not decode them as text and send them to the model, which would produce meaningless content.
 */
function fromDataPart(part: vscode.LanguageModelDataPart): { image: ImageBlock } | { text: string } | undefined {
    const mime = part.mimeType.toLowerCase().split(';')[0].trim();
    const format = IMAGE_FORMATS[mime];
    if (format) {
        return { image: { format, source: { bytes: part.data } } };
    }
    if (mime.startsWith('text/') || mime === 'application/json') {
        const text = new TextDecoder().decode(part.data);
        return text.length > 0 ? { text } : undefined;
    }
    return undefined;
}

function toToolResultContent(content: readonly unknown[]): ToolResultContentBlock[] {
    const blocks: ToolResultContentBlock[] = [];
    for (const item of content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            if (item.value.length > 0) {
                blocks.push({ text: item.value });
            }
        } else if (item instanceof vscode.LanguageModelDataPart) {
            // For example, a file-reading tool may return an image. Skip unsupported MIME types instead of serializing binary data as JSON.
            const data = fromDataPart(item);
            if (data) {
                blocks.push('image' in data ? { image: data.image } : { text: data.text });
            }
        } else if (item instanceof vscode.LanguageModelPromptTsxPart) {
            // prompt-tsx structures cannot be converted directly to text; sending JSON preserves their contents at least.
            blocks.push({ text: JSON.stringify(item.value) });
        } else if (item !== undefined && item !== null) {
            blocks.push({ text: typeof item === 'string' ? item : JSON.stringify(item) });
        }
    }
    // Converse requires toolResult.content to be non-empty; return a text block when the tool has no output.
    return blocks.length > 0 ? blocks : [{ text: '(no output)' }];
}

/** Copilot attaches one stateful_marker per earlier message on every request; it is expected noise, so it is not logged. */
function isStatefulMarker(part: unknown): boolean {
    return part instanceof vscode.LanguageModelDataPart && part.mimeType.toLowerCase() === 'stateful_marker';
}

function describePart(part: unknown): string {
    if (part instanceof vscode.LanguageModelDataPart) {
        return `LanguageModelDataPart(${part.mimeType})`;
    }
    if (part && typeof part === 'object') {
        return part.constructor?.name ?? 'object';
    }
    return typeof part;
}
