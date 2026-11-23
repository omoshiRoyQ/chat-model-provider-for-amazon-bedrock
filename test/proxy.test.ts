import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import type * as vscode from 'vscode';
import { fetchModelSources } from '../src/modelList';
import { NativeConverseClient } from '../src/native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEDROCK_CLIENT_SECURITY, ConnectProxyHttpsAgent, createAwsRequestHandler, fetchHttpsText, InvalidProxyUrlError, parseProxyUrl } from '../src/proxy';

/** Generates an ephemeral ECDSA P-256 self-signed X.509 certificate for localhost / 127.0.0.1 TLS loopback tests. */
function generateLoopbackCert(includeLoopbackNames = true): { key: string; cert: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const derLen = (n: number): Buffer =>
        n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
    const seq = (...items: Buffer[]): Buffer => {
        const body = Buffer.concat(items);
        return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
    };
    const set = (...items: Buffer[]): Buffer => {
        const body = Buffer.concat(items);
        return Buffer.concat([Buffer.from([0x31]), derLen(body.length), body]);
    };
    const oid = (hex: string): Buffer => {
        const body = Buffer.from(hex, 'hex');
        return Buffer.concat([Buffer.from([0x06, body.length]), body]);
    };
    const utf8 = (text: string): Buffer => {
        const body = Buffer.from(text, 'utf8');
        return Buffer.concat([Buffer.from([0x0c]), derLen(body.length), body]);
    };
    const utcTime = (text: string): Buffer => {
        const body = Buffer.from(text, 'ascii');
        return Buffer.concat([Buffer.from([0x17, body.length]), body]);
    };

    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const name = seq(set(seq(oid('550403'), utf8('localhost'))));
    const ecdsaWithSha256 = seq(oid('2a8648ce3d040302'));
    // The wrong-host fixture omits localhost and the loopback IP from its SANs.
    const dnsName = (host: string) => {
        const b = Buffer.from(host, 'ascii');
        return Buffer.concat([Buffer.from([0x82]), derLen(b.length), b]);
    };
    const ipAddr = Buffer.from([0x87, 0x04, 127, 0, 0, 1]);
    const sanValue = seq(
        ...(includeLoopbackNames ? [dnsName('localhost'), ipAddr] : []),
        dnsName('bedrock.us-west-2.amazonaws.com'), dnsName('bedrock-runtime.us-west-2.amazonaws.com'), dnsName('docs.aws.amazon.com'),
    );
    const sanOctet = Buffer.concat([Buffer.from([0x04]), derLen(sanValue.length), sanValue]);
    const extensions = Buffer.concat([
        Buffer.from([0xa3]),
        derLen(seq(seq(oid('551d11'), sanOctet)).length),
        seq(seq(oid('551d11'), sanOctet)),
    ]);

    const tbs = seq(
        Buffer.from('a003020102', 'hex'),
        Buffer.from('020101', 'hex'),
        ecdsaWithSha256,
        name,
        seq(utcTime('250101000000Z'), utcTime('350101000000Z')),
        name,
        spki,
        extensions,
    );
    const signature = crypto.sign('sha256', tbs, privateKey);
    const sigBitString = Buffer.concat([Buffer.from([0x03]), derLen(signature.length + 1), Buffer.from([0x00]), signature]);
    const certDer = seq(tbs, ecdsaWithSha256, sigBitString);
    const base64Lines = certDer.toString('base64').match(/.{1,64}/g) ?? [];
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${base64Lines.join('\n')}\n-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    };
}

/** Encodes a single AWS event-stream message frame (`application/vnd.amazon.eventstream`) with `:event-type` and `:message-type` string headers. */
function encodeEventStreamFrame(eventType: string, payloadJson: unknown): Buffer {
    const encodeHeader = (name: string, value: string): Buffer => {
        const nameBuf = Buffer.from(name, 'utf8');
        const valBuf = Buffer.from(value, 'utf8');
        const header = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
        let offset = 0;
        header.writeUInt8(nameBuf.length, offset++);
        nameBuf.copy(header, offset);
        offset += nameBuf.length;
        header.writeUInt8(7, offset++); // Type 7 = string
        header.writeUInt16BE(valBuf.length, offset);
        offset += 2;
        valBuf.copy(header, offset);
        return header;
    };

    const headers = Buffer.concat([
        encodeHeader(':message-type', 'event'),
        encodeHeader(':event-type', eventType),
        encodeHeader(':content-type', 'application/json'),
    ]);
    const payload = Buffer.from(JSON.stringify(payloadJson), 'utf8');
    const totalLength = 12 + headers.length + payload.length + 4;
    const frame = Buffer.alloc(totalLength);
    frame.writeUInt32BE(totalLength, 0);
    frame.writeUInt32BE(headers.length, 4);
    frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
    headers.copy(frame, 12);
    payload.copy(frame, 12 + headers.length);
    frame.writeUInt32BE(crc32(frame.subarray(0, totalLength - 4)), totalLength - 4);
    return frame;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    while (closers.length > 0) {
        const close = closers.pop();
        if (close) {
            await close();
        }
    }
});

function listenServer<T extends net.Server>(server: T): Promise<{ server: T; port: number }> {
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket: net.Socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as net.AddressInfo;
            closers.push(() => new Promise<void>((done) => {
                for (const socket of sockets) {
                    socket.destroy();
                }
                server.close(() => done());
            }));
            resolve({ server, port: addr.port });
        });
    });
}

describe('parseProxyUrl', () => {
    it('treats empty or whitespace values as direct mode', () => {
        expect(parseProxyUrl(undefined)).toBeUndefined();
        expect(parseProxyUrl('')).toBeUndefined();
        expect(parseProxyUrl('   ')).toBeUndefined();
    });

    it('parses valid http and https proxy origins with explicit or default ports', () => {
        expect(parseProxyUrl('http://proxy.example:8080')).toEqual({
            protocol: 'http:',
            host: 'proxy.example',
            port: 8080,
            origin: 'http://proxy.example:8080',
        });
        expect(parseProxyUrl('https://proxy.example/')).toEqual({
            protocol: 'https:',
            host: 'proxy.example',
            port: 443,
            origin: 'https://proxy.example',
        });
        expect(parseProxyUrl('http://[::1]:3128')).toEqual({
            protocol: 'http:',
            host: '::1',
            port: 3128,
            origin: 'http://[::1]:3128',
        });
    });

    it.each([
        ['non-URL', 'not-a-url'],
        ['unsupported scheme', 'ftp://proxy.example:8080'],
        ['socks scheme', 'socks5://proxy.example:1080'],
        ['subpath', 'http://proxy.example:8080/subpath'],
        ['query string', 'http://proxy.example:8080?x=1'],
        ['fragment', 'http://proxy.example:8080#frag'],
    ])('rejects %s (%s)', (_label, value) => {
        expect(() => parseProxyUrl(value)).toThrow(InvalidProxyUrlError);
    });

    it('rejects embedded credentials without echoing the username or password', () => {
        const raw = 'http://alice-user:super-secret-pass@proxy.example:8080';
        let caught: Error | undefined;
        try {
            parseProxyUrl(raw);
        } catch (error) {
            caught = error as Error;
        }
        expect(caught).toBeInstanceOf(InvalidProxyUrlError);
        expect(caught?.message).not.toContain('alice-user');
        expect(caught?.message).not.toContain('super-secret-pass');
    });
});

describe('Web Identity named profile endpoint isolation', () => {
    it('uses SDK-default HTTPS STS for both clients, even with endpoint overrides', async () => {
        // A synthetic AWS-partition region keeps the STS endpoint test independent of user settings.
        const region = 'us-test-1';
        const profile = `fixture-${crypto.randomUUID()}`;
        const tokenValue = 'synthetic-web-identity-token';
        const base = resolve('.tmp');
        mkdirSync(base, { recursive: true });
        const root = mkdtempSync(join(base, 'web-identity-'));
        const config = join(root, 'config');
        const credentials = join(root, 'credentials');
        const tokenFile = join(root, 'token');
        const log = { info: vi.fn() } as unknown as vscode.LogOutputChannel;
        const runtime = new NativeConverseClient(log);
        let restoreTransport: (() => void) | undefined;
        try {
            writeFileSync(config, `[profile ${profile}]\nregion = ${region}\nrole_arn = arn:aws:iam::123456789012:role/Synthetic\nweb_identity_token_file = ${tokenFile}\nendpoint_url = https://profile.invalid\n`);
            writeFileSync(credentials, '');
            writeFileSync(tokenFile, tokenValue);
            vi.stubEnv('AWS_CONFIG_FILE', config);
            vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentials);
            vi.stubEnv('AWS_ENDPOINT_URL_STS', 'https://override.invalid');
            vi.stubEnv('AWS_ENDPOINT_URL', 'https://global.invalid');
            vi.stubEnv('AWS_USE_FIPS_ENDPOINT', 'false');
            vi.stubEnv('AWS_USE_DUALSTACK_ENDPOINT', 'false');
            vi.stubEnv('AWS_IGNORE_CONFIGURED_ENDPOINT_URLS', 'false');
            vi.stubEnv('AWS_STS_REGIONAL_ENDPOINTS', 'regional');
            const hosts: string[] = [];
            const transport = vi.spyOn(ConnectProxyHttpsAgent.prototype, 'createConnection').mockImplementation((options) => {
                hosts.push(`${options.protocol}//${options.host}`);
                throw new Error('Offline transport stop');
            });
            restoreTransport = () => transport.mockRestore();
            const proxyUrl = 'http://127.0.0.1:1';
            const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as unknown as vscode.CancellationToken;
            await expect(fetchModelSources(profile, '', { proxyUrl })).rejects.toThrow('Offline transport stop');
            await expect(runtime.stream({ profile, region: '', proxyUrl, modelId: 'sample', messages: [], toolConfig: undefined }, () => {}, token))
                .rejects.toThrow('Offline transport stop');
            expect(hosts).toEqual([`https://sts.${region}.amazonaws.com`, `https://sts.${region}.amazonaws.com`]);
        } finally {
            restoreTransport?.();
            runtime.dispose();
            for (const file of [config, credentials, tokenFile]) if (existsSync(file)) unlinkSync(file);
            rmdirSync(root);
        }
    });
});

describe('CONNECT proxy routing and environment-variable isolation', () => {
    const tlsCert = generateLoopbackCert();

    it('routes BedrockClient, BedrockRuntimeClient ConverseStream, and fetchHttpsText through an HTTP CONNECT proxy', async () => {
        vi.stubEnv('AWS_ENDPOINT_URL', 'https://override.invalid');
        vi.stubEnv('AWS_IGNORE_CONFIGURED_ENDPOINT_URLS', 'false');
        vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'synthetic-bearer');
        vi.stubEnv('AWS_AUTH_SCHEME_PREFERENCE', 'httpBearerAuth');
        vi.stubEnv('AWS_USE_FIPS_ENDPOINT', 'false');
        vi.stubEnv('AWS_USE_DUALSTACK_ENDPOINT', 'false');
        const targetPaths: string[] = [];
        const authorizations: (string | undefined)[] = [];
        const target = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, (req, res) => {
            targetPaths.push(`${req.method} ${req.headers.host} ${req.url}`);
            authorizations.push(req.headers.authorization);
            if (req.url?.startsWith('/inference-profiles')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    inferenceProfileSummaries: [
                        { inferenceProfileId: 'us.openai.gpt-6.2-sol', inferenceProfileName: 'GPT-6.2 Sol', status: 'ACTIVE' },
                    ],
                }));
                return;
            }
            if (req.url?.includes('/converse-stream')) {
                res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' });
                res.write(encodeEventStreamFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello via proxy' } }));
                res.write(encodeEventStreamFrame('metadata', { usage: { inputTokens: 11, outputTokens: 3 } }));
                res.end();
                return;
            }
            if (req.url === '/bedrock/latest/userguide/toc-contents.json') {
                const compressed = gzipSync(Buffer.from('{"href":"model-card-openai-gpt-6-2-sol.html"}', 'utf8'));
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
                res.end(compressed);
                return;
            }
            res.writeHead(404);
            res.end();
        });
        const { port: targetPort } = await listenServer(target);

        const connectTargets: string[] = [];
        const proxyServer = http.createServer((_req, res) => {
            res.writeHead(405);
            res.end();
        });
        proxyServer.on('connect', (req, clientSocket, head) => {
            connectTargets.push(req.url ?? '');
            // Route every external hostname to the local TLS server without needing external DNS!
            const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) {
                    upstream.write(head);
                }
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
            upstream.on('error', () => clientSocket.destroy());
            clientSocket.on('error', () => upstream.destroy());
        });
        const { port: proxyPort } = await listenServer(proxyServer);
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;

        // Control-plane request to unresolvable external-style hostname succeeds via CONNECT tunnel
        const controlHandler = createAwsRequestHandler(proxyUrl, { ca: tlsCert.cert });
        const bedrock = new BedrockClient({
            ...BEDROCK_CLIENT_SECURITY,
            region: 'us-west-2',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
            requestHandler: controlHandler,
        });
        // Runtime streaming request via HTTP/1.1 CONNECT tunnel
        const runtimeHandler = createAwsRequestHandler(proxyUrl, { ca: tlsCert.cert });
        const runtime = new BedrockRuntimeClient({
            ...BEDROCK_CLIENT_SECURITY,
            region: 'us-west-2',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
            requestHandler: runtimeHandler,
        });

        try {
            const listResp = await bedrock.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 10 }));
            expect(listResp.inferenceProfileSummaries?.[0]?.inferenceProfileId).toBe('us.openai.gpt-6.2-sol');

            const streamResp = await runtime.send(new ConverseStreamCommand({
                modelId: 'us.openai.gpt-6.2-sol',
                messages: [{ role: 'user', content: [{ text: 'hi' }] }],
            }));
            const deltas: string[] = [];
            for await (const ev of streamResp.stream ?? []) {
                if (ev.contentBlockDelta?.delta?.text) {
                    deltas.push(ev.contentBlockDelta.delta.text);
                }
            }
            expect(deltas).toEqual(['Hello via proxy']);

            const docText = await fetchHttpsText('https://docs.aws.amazon.com/bedrock/latest/userguide/toc-contents.json', {
                timeoutMs: 5_000,
                maxBytes: 1024,
                proxyUrl,
                tlsOptions: { ca: tlsCert.cert },
            });
            expect(docText).toContain('model-card-openai-gpt-6-2-sol.html');

            expect(connectTargets).toEqual([
                'bedrock.us-west-2.amazonaws.com:443',
                'bedrock-runtime.us-west-2.amazonaws.com:443',
                'docs.aws.amazon.com:443',
            ]);
            expect(targetPaths).toHaveLength(3);
            expect(authorizations).toEqual([
                expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=test\//),
                expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=test\//),
                undefined,
            ]);
        } finally {
            bedrock.destroy();
            controlHandler.destroy();
            runtime.destroy();
            runtimeHandler.destroy();
        }
    });

    // The trust boundary applies at each TLS handshake, even if Node would otherwise skip verification.
    it.each(['direct', 'https proxy', 'tunnel'] as const)('verifies certificates for %s connections independently of the environment', async (route) => {
        vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
        const wrongHostCert = generateLoopbackCert(false);
        for (const scenario of ['untrusted', 'wrong host', 'trusted'] as const) {
            const requestSeen = vi.fn();
            const connectSeen = vi.fn();
            const cert = scenario === 'wrong host' ? wrongHostCert : tlsCert;
            const { port: targetPort } = await listenServer(https.createServer(route === 'https proxy' ? tlsCert : cert, (_req, res) => {
                requestSeen();
                res.end('ok');
            }));
            let proxyUrl: string | undefined;
            if (route !== 'direct') {
                const proxy = route === 'https proxy' ? https.createServer(cert) : http.createServer();
                proxy.on('connect', (_req, socket) => {
                    connectSeen();
                    const upstream = net.connect(targetPort, '127.0.0.1', () => {
                        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                        socket.pipe(upstream).pipe(socket);
                    });
                    socket.once('close', () => upstream.destroy());
                    upstream.once('error', () => socket.destroy());
                });
                const { port } = await listenServer(proxy);
                proxyUrl = `${route === 'https proxy' ? 'https' : 'http'}://127.0.0.1:${port}`;
            }
            const handler = createAwsRequestHandler(proxyUrl, scenario === 'untrusted' ? undefined : { ca: [tlsCert.cert, cert.cert] });
            try {
                const response = handler.handle({ protocol: 'https:', hostname: '127.0.0.1', port: targetPort, headers: { authorization: 'synthetic' } });
                if (scenario === 'trusted') {
                    const { response: result } = await response;
                    for await (const _chunk of result.body) { /* Drain the response before destroying the agent. */ }
                    expect(requestSeen).toHaveBeenCalledOnce();
                } else {
                    await expect(response).rejects.toMatchObject({
                        code: scenario === 'wrong host' ? 'ERR_TLS_CERT_ALTNAME_INVALID' : 'DEPTH_ZERO_SELF_SIGNED_CERT',
                    });
                    expect(requestSeen).not.toHaveBeenCalled();
                    if (route === 'https proxy') expect(connectSeen).not.toHaveBeenCalled();
                }
            } finally {
                handler.destroy();
            }
        }
    });

    it('ignores HTTPS_PROXY and HTTP_PROXY environment variables when proxyUrl is empty', async () => {
        let envProxyHit = false;
        const badProxy = http.createServer((_req, res) => {
            envProxyHit = true;
            res.writeHead(500);
            res.end();
        });
        badProxy.on('connect', (_req, socket) => {
            envProxyHit = true;
            socket.destroy();
        });
        const { port: badProxyPort } = await listenServer(badProxy);

        for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
            vi.stubEnv(key, `http://127.0.0.1:${badProxyPort}`);
        }

        const directTarget = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('direct-ok');
        });
        const { port: directPort } = await listenServer(directTarget);

        const body = await fetchHttpsText(`https://localhost:${directPort}/test`, {
            timeoutMs: 5_000,
            maxBytes: 1024,
            proxyUrl: '',
            tlsOptions: { ca: tlsCert.cert },
        });
        expect(body).toBe('direct-ok');
        expect(envProxyHit).toBe(false);
    });

    it('blocks cleartext AWS requests before opening a connection', async () => {
        const connection = vi.fn();
        const target = http.createServer((_req, res) => res.end());
        target.on('connection', connection);
        const { port } = await listenServer(target);
        const handler = createAwsRequestHandler(undefined);
        try {
            await expect(handler.handle({ protocol: 'http:', hostname: '127.0.0.1', port })).rejects.toThrow('AWS requests require HTTPS');
            expect(connection).not.toHaveBeenCalled();
        } finally {
            handler.destroy();
        }
    });

    it('closes a stalled response when cancelled after headers', async () => {
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
        const target = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, (_req, res) => {
            res.once('close', resolveClosed);
            res.writeHead(200);
            res.flushHeaders();
        });
        const { port } = await listenServer(target);
        const abort = new AbortController();
        const handler = createAwsRequestHandler(undefined, { ca: tlsCert.cert });
        try {
            const { response } = await handler.handle({ protocol: 'https:', hostname: 'localhost', port }, { abortSignal: abort.signal });
            const next = response.body[Symbol.asyncIterator]().next();
            abort.abort();
            await expect(next).rejects.toMatchObject({ name: 'AbortError' });
            await closed;
        } finally {
            handler.destroy();
        }
    });

    it('closes a pending CONNECT when the request is cancelled', async () => {
        const abort = new AbortController();
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
        const proxyServer = http.createServer();
        proxyServer.on('connect', (_req, socket) => {
            socket.once('end', () => {
                socket.destroy();
                resolveClosed();
            });
            socket.resume();
            abort.abort();
        });
        const { port } = await listenServer(proxyServer);
        const handler = createAwsRequestHandler(`http://127.0.0.1:${port}`);
        try {
            await expect(handler.handle({ protocol: 'https:', hostname: 'docs.aws.amazon.com' }, { abortSignal: abort.signal }))
                .rejects.toMatchObject({ name: 'AbortError' });
            await closed;
        } finally {
            handler.destroy();
        }
    });

    it('times out an unfinished CONNECT and closes its socket', async () => {
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
        const proxyServer = http.createServer();
        proxyServer.on('connect', (_req, socket) => {
            socket.once('end', () => {
                socket.destroy();
                resolveClosed();
            });
            socket.resume();
        });
        const { port } = await listenServer(proxyServer);
        const agent = new ConnectProxyHttpsAgent(parseProxyUrl(`http://127.0.0.1:${port}`)!, undefined, 500);
        try {
            await expect(new Promise((_resolve, reject) => {
                https.get('https://docs.aws.amazon.com/', { agent }).on('error', reject);
            })).rejects.toMatchObject({ name: 'TimeoutError' });
            await closed;
        } finally {
            agent.destroy();
        }
    });

    it('limits both received and decompressed bytes', async () => {
        const target = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, (req, res) => {
            const body = Buffer.alloc(req.url?.includes('over') ? 65 : 64, 'a');
            if (req.url?.includes('gzip')) {
                res.setHeader('Content-Encoding', 'gzip');
                res.end(gzipSync(body));
            } else {
                res.write(body.subarray(0, 32));
                res.end(body.subarray(32));
            }
        });
        const { port } = await listenServer(target);
        const options = { timeoutMs: 5_000, maxBytes: 64, tlsOptions: { ca: tlsCert.cert } };
        for (const mode of ['plain', 'gzip']) {
            await expect(fetchHttpsText(`https://localhost:${port}/${mode}`, options)).resolves.toBe('a'.repeat(64));
            await expect(fetchHttpsText(`https://localhost:${port}/${mode}-over`, options)).rejects.toThrow('64-byte size limit');
        }
    });

    it('follows same-origin redirects but rejects cross-origin redirects before connecting', async () => {
        const requests: string[] = [];
        const target = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, (req, res) => {
            requests.push(req.url ?? '');
            if (req.url === '/final') {
                res.end('ok');
                return;
            }
            const location = req.url === '/same' ? '/final' : `https://127.0.0.1:${port}/final`;
            res.writeHead(302, { Location: location });
            res.end();
        });
        const { port } = await listenServer(target);
        const options = { timeoutMs: 5_000, maxBytes: 64, tlsOptions: { ca: tlsCert.cert } };
        await expect(fetchHttpsText(`https://localhost:${port}/same`, options)).resolves.toBe('ok');
        await expect(fetchHttpsText(`https://localhost:${port}/cross`, options)).rejects.toThrow('requires the original origin');
        expect(requests).toEqual(['/same', '/final', '/cross']);
    });

    it('surfaces HTTP 407 / non-2xx CONNECT rejection clearly', async () => {
        const rejectingProxy = http.createServer();
        rejectingProxy.on('connect', (_req, socket) => {
            socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            socket.end();
        });
        const { port: proxyPort } = await listenServer(rejectingProxy);

        await expect(
            fetchHttpsText('https://docs.aws.amazon.com/bedrock/latest/userguide/toc-contents.json', {
                timeoutMs: 5_000,
                maxBytes: 1024,
                proxyUrl: `http://127.0.0.1:${proxyPort}`,
            }),
        ).rejects.toThrow(/407 Proxy Authentication Required/);
    });
});
