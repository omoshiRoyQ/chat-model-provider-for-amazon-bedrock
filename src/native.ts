import {
    BedrockRuntimeClient,
    ConverseStreamCommand,
    type Message,
    type SystemContentBlock,
    type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import * as vscode from 'vscode';
import type { Document } from './convert';

/** Token usage reported in Bedrock's final stream metadata event. */
export interface TokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
}

/** Content reported to the caller while streaming. */
export type StreamPart =
    | { kind: 'text'; text: string }
    | { kind: 'toolCall'; callId: string; name: string; input: object };

/**
 * Native path: calls the Bedrock Converse API through the AWS SDK.
 *
 * Credentials are provided by `fromIni({ profile })` and resolved by the SDK for every request.
 * The SDK refreshes credentials five minutes before expiration. Failed provider results are not cached,
 * so the next request can succeed after the user runs `aws sso login`; VS Code does not need to be restarted.
 * Only the client object is cached here; accessKeyId, secretAccessKey, and sessionToken are never stored.
 */
export class NativeConverseClient {
    private client: BedrockRuntimeClient | undefined;
    private clientKey = '';

    constructor(private readonly log: vscode.LogOutputChannel) { }

    private getClient(profile: string, region: string): BedrockRuntimeClient {
        const key = `${profile}|${region}`;
        if (!this.client || this.clientKey !== key) {
            this.client?.destroy();
            this.client = new BedrockRuntimeClient({
                // `profile` lets the SDK read the region from the profile when region is empty.
                profile,
                region: region || undefined,
                credentials: fromIni({ profile }),
            });
            this.clientKey = key;
            this.log.info(`Created BedrockRuntimeClient: profile=${profile}, region=${region || '(from profile)'}`);
        }
        return this.client;
    }

    /**
    * Calls ConverseStream.
     *
    * Text is reported as soon as it arrives. A toolUse input is delivered as JSON string fragments,
    * so it is reported only after all fragments have been collected and contentBlockStop arrives.
    * Event order is based on 2026-09-25 testing: contentBlockStart(toolUse) → contentBlockDelta(toolUse.input)… → contentBlockStop.
     */
    async stream(
        params: {
            profile: string;
            region: string;
            modelId: string;
            messages: Message[];
            system?: SystemContentBlock[];
            toolConfig: ToolConfiguration | undefined;
            /** Model-specific parameters such as thinking, passed through in additionalModelRequestFields. */
            additionalFields?: Record<string, Document>;
            maxTokens?: number;
        },
        onPart: (part: StreamPart) => void,
        token: vscode.CancellationToken,
    ): Promise<TokenUsage | undefined> {
        let usage: TokenUsage | undefined;
        const abort = new AbortController();
        const cancel = token.onCancellationRequested(() => abort.abort());
        // Store in-progress toolUse blocks by contentBlockIndex.
        const pendingTools = new Map<number, { callId: string; name: string; input: string }>();
        try {
            const response = await this.getClient(params.profile, params.region).send(
                new ConverseStreamCommand({
                    modelId: params.modelId,
                    messages: params.messages,
                    system: params.system,
                    toolConfig: params.toolConfig,
                    additionalModelRequestFields: params.additionalFields,
                    inferenceConfig: params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : undefined,
                }),
                { abortSignal: abort.signal },
            );
            if (!response.stream) {
                throw new Error('ConverseStream response has no stream');
            }
            for await (const event of response.stream) {
                if (token.isCancellationRequested) {
                    break;
                }
                if (event.contentBlockStart) {
                    const toolUse = event.contentBlockStart.start?.toolUse;
                    const index = event.contentBlockStart.contentBlockIndex;
                    if (toolUse && index !== undefined) {
                        pendingTools.set(index, { callId: toolUse.toolUseId ?? '', name: toolUse.name ?? '', input: '' });
                    }
                } else if (event.contentBlockDelta) {
                    const delta = event.contentBlockDelta.delta;
                    const index = event.contentBlockDelta.contentBlockIndex;
                    if (delta?.text) {
                        onPart({ kind: 'text', text: delta.text });
                    } else if (delta?.toolUse && index !== undefined) {
                        const pending = pendingTools.get(index);
                        if (pending) {
                            pending.input += delta.toolUse.input ?? '';
                        }
                    }
                } else if (event.contentBlockStop) {
                    const index = event.contentBlockStop.contentBlockIndex;
                    const pending = index !== undefined ? pendingTools.get(index) : undefined;
                    if (pending && index !== undefined) {
                        pendingTools.delete(index);
                        onPart({ kind: 'toolCall', callId: pending.callId, name: pending.name, input: parseToolInput(pending.input, pending.name) });
                    }
                } else if (event.messageStop) {
                    this.log.info(`model=${params.modelId} completed, stopReason=${event.messageStop.stopReason}`);
                } else if (event.metadata?.usage) {
                    const u = event.metadata.usage;
                    this.log.info(`model=${params.modelId} usage: input=${u.inputTokens}, output=${u.outputTokens}`);
                    if (u.inputTokens !== undefined && u.outputTokens !== undefined) {
                        usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
                    }
                }
            }
        } finally {
            cancel.dispose();
        }
        return usage;
    }
}

/**
 * Parses toolUse input. A model may send no delta for a tool without parameters, leaving an empty string; treat it as an empty object.
 * Throw on incomplete JSON instead of silently using an empty object, which could execute the tool with incorrect arguments.
 */
export function parseToolInput(raw: string, toolName: string): object {
    if (raw.trim() === '') {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        throw new Error('Tool input is not a JSON object');
    } catch (error) {
        // Omit the raw input: it is chat-derived model output, and this message is written to the log.
        throw new Error(`Failed to parse input for tool "${toolName}": ${(error as Error).message}; length=${raw.length}`);
    }
}
