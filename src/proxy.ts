import { fromIni, fromWebToken } from '@aws-sdk/credential-providers';
import type * as http from 'node:http';
import { addAbortListener } from 'node:events';
import * as https from 'node:https';
import * as net from 'node:net';
import { addAbortSignal } from 'node:stream';
import * as tls from 'node:tls';
import { promisify } from 'node:util';
import { gunzip, inflate } from 'node:zlib';

const CONNECT_TIMEOUT_MS = 15_000;
const AWS_IDLE_TIMEOUT_MS = 300_000;
const TUNNEL_SIGNAL = Symbol('tunnelSignal');
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

export const BEDROCK_CLIENT_SECURITY = {
    ignoreConfiguredEndpointUrls: true,
    authSchemePreference: ['sigv4'],
};

export function createNamedProfileCredentials(profile: string, requestHandler: AwsRequestHandler, region: () => Promise<string>): ReturnType<typeof fromIni> {
    const clientConfig = { requestHandler, ignoreConfiguredEndpointUrls: true };
    return fromIni({
        profile,
        clientConfig,
        // The locked fromIni Web Identity branch does not forward clientConfig to STS.
        roleAssumerWithWebIdentity: (params) => fromWebToken({
            roleArn: params.RoleArn,
            roleSessionName: params.RoleSessionName,
            webIdentityToken: params.WebIdentityToken,
            clientConfig: { ...clientConfig, profile, region },
        })(),
    });
}

export interface ParsedProxyUrl {
    readonly protocol: 'http:' | 'https:';
    readonly host: string;
    readonly port: number;
    /** Normalized origin without credentials, safe to include in logs or diagnostics. */
    readonly origin: string;
}

export interface AwsRequestHandler {
    readonly metadata?: { readonly handlerProtocol: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle(request: any, options?: any): Promise<any>;
    destroy(): void;
}

/**
 * HTTP/1.1 Smithy `RequestHandler` implemented on Node's HTTPS module with our explicit
 * `DirectHttpsAgent` / `ConnectProxyHttpsAgent`. Bundled into `dist/extension.js` with zero extra runtime packages,
 * and avoids `BedrockRuntimeClient`'s default HTTP/2 `NodeHttp2Handler` which bypasses HTTP(S) proxies.
 */
class Http1AwsRequestHandler implements AwsRequestHandler {
    readonly metadata = { handlerProtocol: 'http/1.1' } as const;

    constructor(private readonly httpsAgent: https.Agent) { }

    destroy(): void {
        this.httpsAgent.destroy();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle(request: any, options: { abortSignal?: AbortSignal; requestTimeout?: number } = {}): Promise<{ response: any }> {
        const abortSignal = options.abortSignal;
        if (abortSignal?.aborted) {
            const abortError = new Error('Request aborted');
            abortError.name = 'AbortError';
            return Promise.reject(abortError);
        }

        if (request.protocol !== 'https:') {
            return Promise.reject(new Error('AWS requests require HTTPS.'));
        }
        const query = buildSmithyQueryString(request.query);
        let path = (request.path as string | undefined) || '/';
        if (query) {
            path += `?${query}`;
        }
        if (request.fragment) {
            path += `#${request.fragment}`;
        }
        const rawHost = (request.hostname as string | undefined) ?? '';
        const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId: NodeJS.Timeout | undefined;
            const finish = (err: Error | null, response?: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                if (err) {
                    reject(err);
                } else {
                    resolve({ response });
                }
            };

            const timeoutController = options.requestTimeout && options.requestTimeout > 0 ? new AbortController() : undefined;
            const tunnelSignal = abortSignal && timeoutController
                ? AbortSignal.any([abortSignal, timeoutController.signal]) : abortSignal ?? timeoutController?.signal;
            const requestOptions = {
                host,
                port: request.port,
                method: request.method ?? 'GET',
                path,
                headers: request.headers,
                agent: this.httpsAgent,
                signal: abortSignal,
                [TUNNEL_SIGNAL]: tunnelSignal,
                timeout: AWS_IDLE_TIMEOUT_MS,
            };
            const req = https.request(requestOptions,
                (res) => {
                    if (abortSignal) {
                        addAbortSignal(abortSignal, res);
                    }
                    res.on('timeout', onTimeout);
                    const headers: Record<string, string> = {};
                    for (const [key, val] of Object.entries(res.headers)) {
                        if (val !== undefined) {
                            headers[key.toLowerCase()] = Array.isArray(val) ? val.join(', ') : val;
                        }
                    }
                    finish(null, {
                        statusCode: res.statusCode ?? -1,
                        reason: res.statusMessage,
                        headers,
                        body: res,
                    });
                },
            );

            function onTimeout(): void {
                const error = new Error('AWS request timed out waiting for network activity.');
                error.name = 'TimeoutError';
                req.destroy(error);
            }
            req.on('timeout', onTimeout);

            if (timeoutController) {
                timeoutId = setTimeout(() => {
                    const timeoutError = new Error(`Request timed out after ${options.requestTimeout}ms`);
                    timeoutError.name = 'TimeoutError';
                    req.destroy(timeoutError);
                    timeoutController.abort(timeoutError);
                    finish(timeoutError);
                }, options.requestTimeout);
            }

            req.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
                    finish(Object.assign(err, { name: 'TimeoutError' }));
                } else {
                    finish(err);
                }
            });

            writeSmithyBody(req, request.body).catch((err) => {
                req.destroy();
                finish(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }
}

function buildSmithyQueryString(query: Record<string, string | string[] | null | undefined> | undefined): string {
    if (!query) {
        return '';
    }
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
            continue;
        }
        const encodedKey = encodeURIComponent(key);
        if (value === null) {
            parts.push(encodedKey);
        } else if (Array.isArray(value)) {
            for (const item of value) {
                parts.push(`${encodedKey}=${encodeURIComponent(item)}`);
            }
        } else {
            parts.push(`${encodedKey}=${encodeURIComponent(value)}`);
        }
    }
    return parts.join('&');
}

async function writeSmithyBody(req: http.ClientRequest, body: unknown): Promise<void> {
    if (body === undefined || body === null) {
        req.end();
        return;
    }
    if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
        req.end(body);
        return;
    }
    if (typeof (body as { pipe?: unknown }).pipe === 'function') {
        await new Promise<void>((resolve, reject) => {
            const readable = body as NodeJS.ReadableStream;
            readable.on('error', reject);
            req.on('error', reject);
            req.on('finish', resolve);
            readable.pipe(req);
        });
        return;
    }
    if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
            req.write(chunk);
        }
        req.end();
        return;
    }
    req.end(String(body));
}

export class InvalidProxyUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidProxyUrlError';
    }
}

/**
 * Validates `amazonBedrockProvider.proxyUrl`.
 * - Empty or whitespace-only string returns `undefined` (direct connection, ignoring `HTTP_PROXY` / `HTTPS_PROXY`).
 * - Accepts only `http:` or `https:` origins (optional `/` path, no subpath, query, or hash).
 * - Rejects embedded credentials without echoing the raw value or password in the error message.
 */
export function parseProxyUrl(raw: string | undefined): ParsedProxyUrl | undefined {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
        return undefined;
    }
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new InvalidProxyUrlError('Invalid amazonBedrockProvider.proxyUrl: expected an http:// or https:// proxy URL.');
    }
    if (parsed.username !== '' || parsed.password !== '') {
        throw new InvalidProxyUrlError('Invalid amazonBedrockProvider.proxyUrl: embedded credentials are not supported in proxyUrl.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new InvalidProxyUrlError(`Invalid amazonBedrockProvider.proxyUrl: unsupported scheme "${parsed.protocol}" (expected http: or https:).`);
    }
    if (!parsed.hostname) {
        throw new InvalidProxyUrlError('Invalid amazonBedrockProvider.proxyUrl: proxy host is missing.');
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') {
        throw new InvalidProxyUrlError('Invalid amazonBedrockProvider.proxyUrl: path, query, and fragment are not supported.');
    }
    const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new InvalidProxyUrlError('Invalid amazonBedrockProvider.proxyUrl: invalid port.');
    }
    const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    return {
        protocol: parsed.protocol,
        host,
        port,
        origin: parsed.origin,
    };
}

function formatAuthorityHost(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function defaultServername(host: string): string | undefined {
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return net.isIP(bare) === 0 ? bare : undefined;
}

/**
 * Explicit direct HTTPS agent that always connects via `tls.connect` and never reads `HTTP_PROXY` / `HTTPS_PROXY`
 * or `https.globalAgent`.
 */
class DirectHttpsAgent extends https.Agent {
    constructor(tlsOptions?: tls.ConnectionOptions) {
        super({ keepAlive: true, maxSockets: 50, ...tlsOptions });
    }

    override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: net.Socket) => void): net.Socket {
        const opts = options as tls.ConnectionOptions & { host?: string; hostname?: string; port?: number | string };
        const rawHost = opts.hostname || opts.host || 'localhost';
        const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
        const port = Number(opts.port) || 443;
        const servername = opts.servername ?? defaultServername(host);
        const socket = tls.connect({
            ...opts,
            host,
            port,
            rejectUnauthorized: true,
            ...(servername ? { servername } : {}),
        });
        if (callback) {
            const onError = (err: Error) => callback(err, socket);
            socket.once('error', onError);
            socket.once('secureConnect', () => {
                socket.removeListener('error', onError);
            });
        }
        return socket;
    }
}

export interface ProxyTlsOptions {
    /** Extra CA certificate(s) for testing local HTTPS target or HTTPS proxy servers. */
    readonly ca?: string | Buffer | Array<string | Buffer>;
}

/**
 * HTTPS agent that tunnels requests through an explicit `http:` or `https:` proxy via HTTP `CONNECT`, then performs
 * end-to-end TLS with the destination host.
 */
export class ConnectProxyHttpsAgent extends https.Agent {
    private readonly pending = new Set<() => void>();

    override destroy(): void {
        for (const cancel of this.pending) {
            cancel();
        }
        super.destroy();
    }

    constructor(
        private readonly proxy: ParsedProxyUrl,
        private readonly tlsOptions?: ProxyTlsOptions,
        private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS,
    ) {
        super({ keepAlive: true, maxSockets: 50 });
    }

    // Returning `null` (typed via cast) instructs Node's `http.Agent.createSocket` to wait for the async `callback(err, tlsSocket)`.
    override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: net.Socket) => void): net.Socket {
        // Node forwards custom agent options, but removes its own signal before calling the agent.
        const opts = options as tls.ConnectionOptions & { host?: string; hostname?: string; port?: number | string; [TUNNEL_SIGNAL]?: AbortSignal };
        const signal = opts[TUNNEL_SIGNAL];
        const targetHost = opts.hostname || opts.host || 'localhost';
        const targetPort = Number(opts.port) || 443;
        const authority = `${formatAuthorityHost(targetHost)}:${targetPort}`;
        const servername = opts.servername ?? defaultServername(targetHost);

        let settled = false;
        let proxySocket: net.Socket | undefined;
        let tlsSocket: tls.TLSSocket | undefined;
        let abortListener: ReturnType<typeof addAbortListener> | undefined;
        const finish = (err: Error | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            abortListener?.[Symbol.dispose]();
            this.pending.delete(cancel);
            if (err) {
                tlsSocket?.destroy();
                proxySocket?.destroy();
                callback?.(err, undefined as unknown as net.Socket);
                return;
            }
            callback?.(null, tlsSocket!);
        };
        const cancel = () => finish(new Error('Proxy connection closed.'));
        const timer = setTimeout(() => {
            const error = new Error('Timed out establishing the proxy tunnel.');
            error.name = 'TimeoutError';
            finish(error);
        }, this.connectTimeoutMs);
        this.pending.add(cancel);
        if (signal) {
            const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Proxy connection cancelled.'));
            if (signal.aborted) {
                onAbort();
                return null as unknown as net.Socket;
            }
            abortListener = addAbortListener(signal, onAbort);
        }

        const onProxyConnected = () => {
            if (!proxySocket || settled) {
                return;
            }
            let headerBuffer = Buffer.alloc(0);
            const onData = (chunk: Buffer) => {
                headerBuffer = Buffer.concat([headerBuffer, chunk]);
                const headerEnd = headerBuffer.indexOf('\r\n\r\n');
                if ((headerEnd === -1 ? headerBuffer.length : headerEnd + 4) > 65_536) {
                    cleanupListeners();
                    finish(new Error(`Proxy ${this.proxy.origin} sent oversized CONNECT response headers`));
                    return;
                }
                if (headerEnd === -1) {
                    return;
                }
                cleanupListeners();
                const statusLine = headerBuffer.subarray(0, headerBuffer.indexOf('\r\n')).toString('latin1');
                const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine);
                const statusCode = match ? Number(match[1]) : 0;
                if (statusCode < 200 || statusCode >= 300) {
                    finish(new Error(`Proxy ${this.proxy.origin} rejected CONNECT to ${authority} with ${statusLine || 'invalid response'}`));
                    return;
                }
                const remainder = headerBuffer.subarray(headerEnd + 4);
                if (remainder.length > 0) {
                    proxySocket!.unshift(remainder);
                }
                const destinationSocket = tls.connect({
                    socket: proxySocket,
                    host: targetHost.replace(/^\[|\]$/g, ''),
                    ...(servername ? { servername } : {}),
                    ...(this.tlsOptions?.ca ? { ca: this.tlsOptions.ca } : {}),
                    ...(opts.ca ? { ca: opts.ca } : {}),
                    rejectUnauthorized: true,
                });
                tlsSocket = destinationSocket;
                const onTlsError = (err: Error) => finish(err);
                destinationSocket.once('error', onTlsError);
                destinationSocket.once('close', cancel);
                destinationSocket.once('secureConnect', () => {
                    destinationSocket.removeListener('error', onTlsError);
                    destinationSocket.removeListener('close', cancel);
                    finish(null);
                });
            };
            const onClose = () => {
                cleanupListeners();
                finish(new Error(`Proxy ${this.proxy.origin} closed connection before completing CONNECT to ${authority}`));
            };
            const onError = (err: Error) => {
                cleanupListeners();
                finish(err);
            };
            const cleanupListeners = () => {
                proxySocket?.removeListener('data', onData);
                proxySocket?.removeListener('close', onClose);
                proxySocket?.removeListener('error', onError);
            };

            proxySocket.on('data', onData);
            proxySocket.once('close', onClose);
            proxySocket.once('error', onError);
            proxySocket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`);
        };

        try {
            if (this.proxy.protocol === 'https:') {
                const proxyServername = defaultServername(this.proxy.host);
                proxySocket = tls.connect(
                    {
                        host: this.proxy.host,
                        port: this.proxy.port,
                        rejectUnauthorized: true,
                        ...(proxyServername ? { servername: proxyServername } : {}),
                        ...(this.tlsOptions?.ca ? { ca: this.tlsOptions.ca } : {}),
                    },
                    onProxyConnected,
                );
            } else {
                proxySocket = net.connect({ host: this.proxy.host, port: this.proxy.port }, onProxyConnected);
            }
            proxySocket.once('error', (err) => finish(err));
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }

        return null as unknown as net.Socket;
    }
}

/**
 * Creates an HTTP/1.1 `requestHandler` for AWS SDK clients (`BedrockClient`, `BedrockRuntimeClient`, and nested SSO/STS clients).
 * Owns its agents and destroys them when `destroy()` is called.
 */
export function createAwsRequestHandler(rawProxyUrl: string | undefined, tlsOptions?: ProxyTlsOptions): AwsRequestHandler {
    const proxy = parseProxyUrl(rawProxyUrl);
    const httpsAgent = proxy ? new ConnectProxyHttpsAgent(proxy, tlsOptions) : new DirectHttpsAgent(tlsOptions);
    return new Http1AwsRequestHandler(httpsAgent);
}

/**
 * Fetches UTF-8 text from an `https:` URL (such as AWS pricing files or public model cards) using the extension's
 * explicit `proxyUrl` setting, without consulting `HTTP_PROXY` / `HTTPS_PROXY` environment variables.
 */
export async function fetchHttpsText(
    url: string,
    options: {
        readonly timeoutMs: number;
        readonly maxBytes: number;
        readonly proxyUrl?: string;
        readonly tlsOptions?: ProxyTlsOptions;
        readonly maxRedirects?: number;
    },
): Promise<string> {
    let target = new URL(url);
    const { origin } = target;
    const proxy = parseProxyUrl(options.proxyUrl);
    const agent = proxy ? new ConnectProxyHttpsAgent(proxy, options.tlsOptions) : new DirectHttpsAgent(options.tlsOptions);
    const deadline = Date.now() + options.timeoutMs;
    const maxRedirects = options.maxRedirects ?? 5;
    const sizeError = () => new Error(`HTTPS download exceeds the ${options.maxBytes}-byte size limit.`);

    try {
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
            if (target.protocol !== 'https:' || target.origin !== origin || target.username || target.password) {
                throw new Error('HTTPS download requires the original origin and no URL credentials.');
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                const timeoutError = new Error(`Request timed out after ${options.timeoutMs}ms (${url})`);
                timeoutError.name = 'TimeoutError';
                throw timeoutError;
            }
            const result = await new Promise<{ statusCode: number; statusMessage: string; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
                const timeout = new AbortController();
                const requestOptions = {
                    method: 'GET',
                    agent,
                    [TUNNEL_SIGNAL]: timeout.signal,
                    headers: {
                        'Accept-Encoding': 'gzip, deflate',
                        'User-Agent': 'node',
                    },
                    ...(options.tlsOptions?.ca ? { ca: options.tlsOptions.ca } : {}),
                };
                const req = https.request(target, requestOptions,
                    (res) => {
                        const statusCode = res.statusCode ?? 0;
                        const metadata = { statusCode, statusMessage: res.statusMessage ?? '', headers: res.headers };
                        res.on('error', (err) => {
                            clearTimeout(timer);
                            reject(err);
                        });
                        if (statusCode < 200 || statusCode >= 300) {
                            clearTimeout(timer);
                            res.destroy();
                            resolve({ ...metadata, body: Buffer.alloc(0) });
                            return;
                        }
                        const chunks: Buffer[] = [];
                        let size = 0;
                        res.on('data', (chunk: Buffer) => {
                            size += chunk.length;
                            if (size > options.maxBytes) {
                                res.destroy(sizeError());
                                return;
                            }
                            chunks.push(chunk);
                        });
                        res.on('end', () => {
                            clearTimeout(timer);
                            resolve({ ...metadata, body: Buffer.concat(chunks, size) });
                        });
                    },
                );
                const timer = setTimeout(() => {
                    const error = new Error(`Request timed out after ${options.timeoutMs}ms (${url})`);
                    error.name = 'TimeoutError';
                    req.destroy(error);
                    timeout.abort(error);
                    reject(error);
                }, remainingMs);
                req.on('error', (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
                req.end();
            });

            if ([301, 302, 303, 307, 308].includes(result.statusCode) && typeof result.headers.location === 'string') {
                try {
                    target = new URL(result.headers.location, target);
                } catch {
                    throw new Error('HTTPS download received an invalid redirect.');
                }
                continue;
            }
            if (result.statusCode < 200 || result.statusCode >= 300) {
                throw new Error(`HTTP ${result.statusCode} ${result.statusMessage} (${url})`);
            }
            const encoding = (result.headers['content-encoding'] ?? '').toLowerCase();
            const decode = encoding === 'gzip' || encoding === 'x-gzip' ? gunzipAsync : encoding === 'deflate' ? inflateAsync : undefined;
            try {
                const decoded = decode ? await decode(result.body, { maxOutputLength: options.maxBytes }) : result.body;
                return decoded.toString('utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
                    throw sizeError();
                }
                throw error;
            }
        }
        throw new Error(`Too many redirects (${url})`);
    } finally {
        agent.destroy();
    }
}
