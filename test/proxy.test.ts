import { createServer } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import { connect } from 'node:net';
import { once } from 'node:events';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler, NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ProxyAwareHttpHandler, proxyHostHeaderPlugin } from '../src/proxy';

const proxyVariables = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];
const request: Parameters<NodeHttp2Handler['handle']>[0] = {
    protocol: 'https:',
    hostname: 'bedrock-runtime.example.test',
    method: 'POST',
    path: '/model/test/converse-stream',
    headers: {},
    query: {},
    clone() { return this; },
};
const debug = vi.fn();
const log = { debug } as unknown as vscode.LogOutputChannel;
const originalHttpHandle = NodeHttpHandler.prototype.handle;

async function configuredAgent(transport: unknown) {
    if (!(transport instanceof NodeHttpHandler)) {
        throw new Error('Expected an HTTP/1.1 handler');
    }
    // Resolve the real handler's lazy configuration without opening a socket.
    await expect(originalHttpHandle.call(transport, request, { abortSignal: AbortSignal.abort() }))
        .rejects.toMatchObject({ name: 'AbortError' });
    return transport.httpHandlerConfigs().httpsAgent;
}

beforeEach(() => {
    for (const name of proxyVariables) {
        vi.stubEnv(name, '');
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    debug.mockClear();
});

// Expected routing follows the task specification and proxy-from-env's documented NO_PROXY rules.
describe('ProxyAwareHttpHandler', () => {
    function handlers() {
        const response = { response: { statusCode: 200, headers: {} } };
        return {
            direct: vi.spyOn(NodeHttp2Handler.prototype, 'handle').mockResolvedValue(response),
            proxy: vi.spyOn(NodeHttpHandler.prototype, 'handle').mockResolvedValue(response),
        };
    }

    it('preserves HTTP/2 without proxy settings and forwards cancellation options', async () => {
        const { direct, proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        const options = { abortSignal: new AbortController().signal, isEventStream: true };
        try {
            await handler.handle(request, options);
            expect(direct).toHaveBeenCalledWith(request, options);
            expect(proxy).not.toHaveBeenCalled();
            expect(debug).toHaveBeenCalledWith('Bedrock runtime transport: proxy=off');
        } finally {
            handler.destroy();
        }
    });

    it.each(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'])('uses HTTP/1.1 and a CONNECT agent for %s', async name => {
        vi.stubEnv(name, 'http://user:password@proxy.example.test:3128');
        const { direct, proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        const options = { abortSignal: new AbortController().signal, requestTimeout: 1000 };
        try {
            await handler.handle(request, options);
            expect(proxy).toHaveBeenCalledWith(request, options);
            expect(direct).not.toHaveBeenCalled();
            expect(await configuredAgent(proxy.mock.contexts[0])).toBeInstanceOf(HttpsProxyAgent);
            expect(debug).toHaveBeenCalledWith('Bedrock runtime transport: proxy=on');
            expect(JSON.stringify(debug.mock.calls)).not.toMatch(/user|password|proxy\.example/);
        } finally {
            handler.destroy();
        }
    });

    it.each([
        ['bedrock-runtime.example.test', undefined],
        ['BEDROCK-RUNTIME.EXAMPLE.TEST', undefined],
        ['.example.test', undefined],
        ['*.example.test', undefined],
        ['unrelated.test, bedrock-runtime.example.test', undefined],
        ['unrelated.test bedrock-runtime.example.test', undefined],
        ['bedrock-runtime.example.test:443', undefined],
        ['bedrock-runtime.example.test:8443', 8443],
        ['*', undefined],
    ])('bypasses the proxy for NO_PROXY=%s and port=%s', async (noProxy, port) => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
        vi.stubEnv('NO_PROXY', noProxy);
        const { direct, proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        try {
            await handler.handle({ ...request, clone: request.clone, port });
            expect(direct).toHaveBeenCalledOnce();
            expect(proxy).not.toHaveBeenCalled();
            expect(debug).toHaveBeenCalledWith('Bedrock runtime transport: proxy=off');
        } finally {
            handler.destroy();
        }
    });

    it.each(['example.test', 'unrelated.test', 'bedrock-runtime.example.test:8443'])('does not bypass for NO_PROXY=%s', async noProxy => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
        vi.stubEnv('NO_PROXY', noProxy);
        const { direct, proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        try {
            await handler.handle(request);
            expect(proxy).toHaveBeenCalledOnce();
            expect(direct).not.toHaveBeenCalled();
        } finally {
            handler.destroy();
        }
    });

    it('honors lowercase precedence for both proxy and no_proxy', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://upper.example.test:3128');
        vi.stubEnv('https_proxy', 'http://lower.example.test:3128');
        vi.stubEnv('NO_PROXY', '*');
        vi.stubEnv('no_proxy', 'unrelated.test');
        const { proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        try {
            await handler.handle(request);
            const agent = await configuredAgent(proxy.mock.contexts[0]);
            expect(agent).toBeInstanceOf(HttpsProxyAgent);
            if (!(agent instanceof HttpsProxyAgent)) {
                throw new Error('Expected a CONNECT agent');
            }
            expect(agent.proxy.hostname).toBe('lower.example.test');
        } finally {
            handler.destroy();
        }
    });

    it('reuses proxy handlers and destroys both transports', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
        const { proxy } = handlers();
        const destroyProxy = vi.spyOn(NodeHttpHandler.prototype, 'destroy');
        const destroyDirect = vi.spyOn(NodeHttp2Handler.prototype, 'destroy');
        const handler = new ProxyAwareHttpHandler(log);
        await handler.handle(request);
        await handler.handle(request);
        expect(proxy.mock.contexts[0]).toBe(proxy.mock.contexts[1]);
        handler.destroy();
        expect(destroyProxy).toHaveBeenCalledOnce();
        expect(destroyDirect).toHaveBeenCalledOnce();
    });

    it.each(['http://user:secret@[invalid', 'socks://user:secret@proxy.example.test'])('rejects an invalid proxy without exposing its URL', proxyUrl => {
        vi.stubEnv('HTTPS_PROXY', proxyUrl);
        const { direct, proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        try {
            expect(() => handler.handle(request)).toThrow('Invalid proxy URL: expected an HTTP or HTTPS URL');
            expect(direct).not.toHaveBeenCalled();
            expect(proxy).not.toHaveBeenCalled();
        } finally {
            handler.destroy();
        }
    });

    it('propagates proxy failures without silently retrying directly', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
        const { direct, proxy } = handlers();
        const failure = new Error('CONNECT refused');
        proxy.mockRejectedValue(failure);
        const handler = new ProxyAwareHttpHandler(log);
        try {
            await expect(handler.handle(request)).rejects.toBe(failure);
            expect(direct).not.toHaveBeenCalled();
        } finally {
            handler.destroy();
        }
    });

    it('applies the BedrockRuntimeClient HTTP/2 default of isolated sessions', async () => {
        const handler = new ProxyAwareHttpHandler(log);
        const setDisable = vi.spyOn(Reflect.get(handler, 'connectionManager'), 'setDisableConcurrentStreams')
            .mockImplementation(() => undefined);
        try {
            // Resolve the real handler's lazy configuration without opening a socket.
            await expect(handler.handle(request, { abortSignal: AbortSignal.abort() }))
                .rejects.toMatchObject({ name: 'AbortError' });
            expect(setDisable).toHaveBeenCalledWith(true);
        } finally {
            handler.destroy();
        }
    });

    it('refuses to proxy a request still prepared for HTTP/2', () => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
        const { direct, proxy } = handlers();
        const handler = new ProxyAwareHttpHandler(log);
        try {
            expect(() => handler.handle({ ...request, clone: request.clone, headers: { ':authority': request.hostname } }))
                .toThrow('Proxy host header middleware is not registered');
            expect(direct).not.toHaveBeenCalled();
            expect(proxy).not.toHaveBeenCalled();
        } finally {
            handler.destroy();
        }
    });
});

describe('proxyHostHeaderPlugin', () => {
    async function run(headers: Record<string, string>) {
        const middleware: Parameters<BedrockRuntimeClient['middlewareStack']['addRelativeTo']>[0][] = [];
        proxyHostHeaderPlugin.applyToStack({ addRelativeTo: (m: never, options: unknown) => {
            expect(options).toMatchObject({ relation: 'after', toMiddleware: 'hostHeaderMiddleware' });
            middleware.push(m);
        } } as never);
        const next = vi.fn().mockResolvedValue({ output: {}, response: {} });
        const req = { ...request, headers: { ...headers } };
        await middleware[0]?.(next, {} as never)({ input: {}, request: req });
        return req.headers;
    }

    it('rewrites :authority to host when a proxy applies', async () => {
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128');
        expect(await run({ ':authority': 'bedrock-runtime.example.test' }))
            .toEqual({ host: 'bedrock-runtime.example.test' });
    });

    it.each([
        ['no proxy', {}],
        ['NO_PROXY match', { HTTPS_PROXY: 'http://proxy.example.test:3128', NO_PROXY: '.example.test' }],
    ])('keeps HTTP/2 headers unchanged for %s', async (_, env: Record<string, string>) => {
        for (const [name, value] of Object.entries(env)) {
            vi.stubEnv(name, value);
        }
        expect(await run({ ':authority': 'bedrock-runtime.example.test' }))
            .toEqual({ ':authority': 'bedrock-runtime.example.test' });
    });
});

function signedHeaders(authorization: string | string[] | undefined): string | undefined {
    return String(authorization).match(/SignedHeaders=([^,]+)/)?.[1];
}

// AWS event-stream framing: total length, headers length, prelude CRC, headers, payload, message CRC.
function eventFrame(eventType: string, event: object): Buffer {
    const headers = Buffer.concat(Object.entries({
        ':message-type': 'event',
        ':event-type': eventType,
        ':content-type': 'application/json',
    }).map(([name, value]) => {
        const size = Buffer.alloc(2);
        size.writeUInt16BE(Buffer.byteLength(value));
        return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)]);
    }));
    const payload = Buffer.from(JSON.stringify(event));
    const frame = Buffer.alloc(16 + headers.length + payload.length);
    frame.writeUInt32BE(frame.length, 0);
    frame.writeUInt32BE(headers.length, 4);
    frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
    headers.copy(frame, 12);
    payload.copy(frame, 12 + headers.length);
    frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
    return frame;
}

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

it('decodes ConverseStream events through a local CONNECT proxy without resolving the target', async () => {
    const connections: string[] = [];
    const received: { host?: string; signed?: string; rawHeaderNames: string[] }[] = [];
    const upstream = createServer((req, res) => {
        expect(req.httpVersion).toBe('1.1');
        received.push({ host: req.headers.host, signed: signedHeaders(req.headers.authorization), rawHeaderNames: req.rawHeaders.filter((_, i) => i % 2 === 0) });
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        res.write(eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'hello' } }));
        res.end(eventFrame('metadata', { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }));
    });

    const proxy = createServer();
    let client: BedrockRuntimeClient | undefined;
    proxy.on('connect', (req, socket, head) => {
        connections.push(req.url ?? '');
        const target = connect({ host: '127.0.0.1', port: upstreamPort }, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) {
                target.write(head);
            }
            socket.pipe(target);
            target.pipe(socket);
        });
        socket.on('close', () => target.destroy());
        target.on('error', error => socket.destroy(error));
        socket.on('error', () => target.destroy());
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') {
        throw new Error('Expected an upstream TCP address');
    }
    const upstreamPort = upstreamAddress.port;
    try {
        proxy.listen(0, '127.0.0.1');
        await once(proxy, 'listening');
        const proxyAddress = proxy.address();
        if (!proxyAddress || typeof proxyAddress === 'string') {
            throw new Error('Expected a proxy TCP address');
        }
        vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${proxyAddress.port}`);
        client = new BedrockRuntimeClient({
            region: 'test-region',
            endpoint: 'http://unresolvable.invalid',
            // Synthetic test-only credentials; no AWS calls or local profiles are used.
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
            requestHandler: new ProxyAwareHttpHandler(log),
            maxAttempts: 1,
        });
        client.middlewareStack.use(proxyHostHeaderPlugin);
        const response = await client.send(new ConverseStreamCommand({ modelId: 'test', messages: [] }));
        const events = [];
        for await (const event of response.stream ?? []) {
            events.push(event);
        }
        expect(connections).toEqual(['unresolvable.invalid:80']);
        // HTTP/1.1 must carry and sign `host`, never the HTTP/2 `:authority` pseudo-header.
        expect(received).toHaveLength(1);
        expect(received[0]?.host).toBe('unresolvable.invalid');
        expect(received[0]?.rawHeaderNames).not.toContain(':authority');
        expect(received[0]?.signed?.split(';')).toContain('host');
        expect(received[0]?.signed?.split(';')).not.toContain(':authority');
        expect(events).toEqual([
            { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hello' } } },
            { metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } },
        ]);
    } finally {
        client?.destroy();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
});

it('decodes ConverseStream over HTTP/2 when the actual endpoint matches NO_PROXY', async () => {
    const received: { authority?: string; host?: string; signed?: string }[] = [];
    const upstream = createHttp2Server();
    upstream.on('stream', (stream, headers) => {
        received.push({ authority: headers[':authority'], host: headers.host, signed: signedHeaders(headers.authorization) });
        stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
        stream.end(eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'direct' } }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected an HTTP/2 TCP address');
    }
    vi.stubEnv('HTTP_PROXY', 'http://unreachable.invalid:3128');
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const client = new BedrockRuntimeClient({
        region: 'test-region',
        endpoint: `http://127.0.0.1:${address.port}`,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        requestHandler: new ProxyAwareHttpHandler(log),
        maxAttempts: 1,
    });
    client.middlewareStack.use(proxyHostHeaderPlugin);
    try {
        const response = await client.send(new ConverseStreamCommand({ modelId: 'test', messages: [] }));
        const events = [];
        for await (const event of response.stream ?? []) {
            events.push(event);
        }
        expect(events).toEqual([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'direct' } } }]);
        // Direct HTTP/2 keeps the SDK default: `:authority` is sent and signed, `host` is not.
        expect(received).toEqual([{
            authority: `127.0.0.1:${address.port}`,
            host: undefined,
            signed: expect.stringMatching(/^:authority;/),
        }]);
        expect(received[0]?.signed?.split(';')).not.toContain('host');
        expect(debug).toHaveBeenCalledWith('Bedrock runtime transport: proxy=off');
    } finally {
        client.destroy();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
});
