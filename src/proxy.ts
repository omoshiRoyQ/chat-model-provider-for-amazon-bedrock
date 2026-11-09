import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler, NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import type * as vscode from 'vscode';

type MiddlewareStack = BedrockRuntimeClient['middlewareStack'];
type BuildMiddleware = Extract<Parameters<MiddlewareStack['add']>[0], (...args: never[]) => unknown>;
type RoutableRequest = Parameters<NodeHttp2Handler['handle']>[0];

/** Resolve the proxy for the SDK's actual endpoint, honoring *_PROXY and NO_PROXY. */
function resolveProxy(request: Pick<RoutableRequest, 'protocol' | 'hostname' | 'port'>): string {
    return getProxyForUrl(`${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}`);
}

function isRoutableRequest(value: unknown): value is RoutableRequest {
    const request = value as Partial<RoutableRequest> | undefined;
    return typeof request?.hostname === 'string' && typeof request.protocol === 'string'
        && typeof request.headers === 'object' && request.headers !== null;
}

/**
 * Rewrite the HTTP/2 `:authority` pseudo-header to `host` for requests that will be proxied over HTTP/1.1.
 * Runs right after the SDK's hostHeaderMiddleware (build step), i.e. before SigV4 signing, so the signed
 * headers always match the transport actually used. Direct requests keep the SDK's HTTP/2 headers unchanged.
 */
export const proxyHostHeaderPlugin = {
    applyToStack(stack: MiddlewareStack): void {
        const middleware: BuildMiddleware = next => async args => {
            const { request } = args as { request?: unknown };
            if (isRoutableRequest(request) && request.headers[':authority'] && resolveProxy(request)) {
                request.headers.host = request.headers[':authority'];
                delete request.headers[':authority'];
            }
            return next(args);
        };
        stack.addRelativeTo(middleware, {
            name: 'proxyHostHeaderMiddleware',
            relation: 'after',
            toMiddleware: 'hostHeaderMiddleware',
            override: true,
        });
    },
};

/**
 * HTTP/2 handler that switches to HTTP/1.1 + CONNECT proxy per request when *_PROXY applies to the endpoint.
 * Register {@link proxyHostHeaderPlugin} on the client so proxied requests are signed with `host`.
 */
export class ProxyAwareHttpHandler extends NodeHttp2Handler {
    private readonly proxyHandlers = new Map<string, NodeHttpHandler>();

    constructor(private readonly log: vscode.LogOutputChannel) {
        // A user-supplied handler bypasses the SDK's defaults; keep the BedrockRuntimeClient HTTP/2 default.
        super({ disableConcurrentStreams: true });
    }

    override handle(
        request: RoutableRequest,
        options?: Parameters<NodeHttp2Handler['handle']>[1],
    ): ReturnType<NodeHttp2Handler['handle']> {
        const proxy = resolveProxy(request);
        this.log.debug(`Bedrock runtime transport: proxy=${proxy ? 'on' : 'off'}`);
        if (!proxy) {
            return super.handle(request, options);
        }
        if (request.headers[':authority']) {
            // HTTP/1.1 cannot carry pseudo-headers, and rewriting them here would invalidate the SigV4 signature.
            throw new Error('Proxy host header middleware is not registered on the Bedrock runtime client');
        }
        let handler = this.proxyHandlers.get(proxy);
        if (!handler) {
            let url: URL;
            try {
                url = new URL(proxy);
            } catch {
                // URL parsing errors may contain proxy credentials; never propagate them.
                throw new Error('Invalid proxy URL: expected an HTTP or HTTPS URL');
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                throw new Error('Invalid proxy URL: expected an HTTP or HTTPS URL');
            }
            const agent = new HttpsProxyAgent(url);
            handler = new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent });
            this.proxyHandlers.set(proxy, handler);
        }
        return handler.handle(request, options);
    }

    override destroy(): void {
        for (const handler of this.proxyHandlers.values()) {
            handler.destroy();
        }
        this.proxyHandlers.clear();
        super.destroy();
    }
}
