import * as vscode from 'vscode';

/** Include the call path in errors so the failing route can be identified. */
export type CallPath = 'Native';

/**
 * Shared fields on AWS SDK errors. SDK errors extend Error; service errors also have `$metadata`,
 * while credential errors are identified by `name`.
 */
interface AwsLikeError {
    name?: string;
    message?: string;
    operation?: string;
    region?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string };
}

// Error names the SDK may throw when an SSO token expires or becomes invalid.
// CredentialsProviderError and TokenProviderError come from @aws-sdk/credential-provider-sso and token-providers;
// ExpiredTokenException and UnrecognizedClientException are service responses to expired credentials.
const CREDENTIAL_ERROR_NAMES = new Set([
    'CredentialsProviderError',
    'TokenProviderError',
    'ExpiredTokenException',
    'ExpiredToken',
    'TokenRefreshRequired',
    'UnrecognizedClientException',
]);

export function isCredentialError(error: unknown): boolean {
    const name = (error as AwsLikeError | undefined)?.name;
    return name !== undefined && CREDENTIAL_ERROR_NAMES.has(name);
}

/** Preserve AWS error details while adding the operation and resolved region that failed. */
export function withOperationContext(error: unknown, operation: string, region?: string): Error {
    const source = (error ?? {}) as AwsLikeError;
    const contextual = new Error(source.message ?? String(error), { cause: error });
    contextual.name = operation === 'ResolveRegion' && /region is missing/i.test(source.message ?? '')
        ? 'RegionNotConfigured'
        : source.name ?? contextual.name;
    const details = contextual as Error & Pick<AwsLikeError, '$metadata' | 'operation' | 'region'>;
    details.operation = operation;
    details.region = region;
    details.$metadata = source.$metadata;
    return contextual;
}

function errorDetails(e: AwsLikeError, modelId: string, path: CallPath): string {
    const code = e.name ?? 'UnknownError';
    const status = e.$metadata?.httpStatusCode;
    const requestId = e.$metadata?.requestId;
    return [
        e.operation ? `operation=${e.operation}` : `model=${modelId}`,
        e.region ? `region=${e.region}` : undefined,
        `path=${path}`,
        `code=${code}`,
        status !== undefined ? `http=${status}` : undefined,
        requestId ? `requestId=${requestId}` : undefined,
    ]
        .filter((part): part is string => part !== undefined)
        .join(', ');
}

/** English diagnostic text for logs; user-facing errors remain localized by describeError. */
export function describeErrorForLog(error: unknown, modelId: string, path: CallPath, profile: string): string {
    const e = (error ?? {}) as AwsLikeError;
    const detail = errorDetails(e, modelId, path);
    const message = e.message ?? (error === undefined ? '' : String(error));
    if (e.operation === 'ResolveRegion' && /region is missing/i.test(message)) {
        return `No AWS Region is configured. Set amazonBedrockProvider.region in VS Code settings or configure a region in AWS profile "${profile}". (${detail})`;
    }
    if (e.name === 'AccessDeniedException' && e.operation === 'ListFoundationModels') {
        return `AWS profile "${profile}" lacks bedrock:ListFoundationModels permission in region ${e.region ?? 'unknown'}. (${detail})`;
    }
    const summary = isCredentialError(error)
        ? `AWS credentials for profile "${profile}" are expired or invalid.`
        : 'Amazon Bedrock request failed.';
    return `${summary} (${detail}) ${redactAwsIdentity(message)}`.trimEnd();
}

function redactAwsIdentity(message: string): string {
    return message
        .replace(/\bUser:\s*arn:[^\s]+/gi, 'User: [AWS principal redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]');
}

/**
 * Converts an AWS error into a user-facing message.
 * Always includes the model ID, call path, and original AWS error code; credential errors also suggest `aws sso login`.
 */
export function describeError(error: unknown, modelId: string, path: CallPath, profile: string): string {
    const e = (error ?? {}) as AwsLikeError;
    const code = e.name ?? 'UnknownError';
    const detail = errorDetails(e, modelId, path);

    if (e.operation === 'ResolveRegion' && /region is missing/i.test(e.message ?? '')) {
        return vscode.l10n.t(
            'No AWS Region is configured. Set `amazonBedrockProvider.region` in VS Code settings or configure a region in AWS profile "{0}".',
            profile,
        );
    }

    if (code === 'AccessDeniedException' && e.operation === 'ListFoundationModels') {
        return vscode.l10n.t(
            'Cannot list Bedrock models: AWS profile "{0}" is not authorized to perform `{1}` in region {2}. Ask your AWS administrator to grant this action. ({3})',
            profile,
            'bedrock:ListFoundationModels',
            e.region ?? 'unknown',
            detail,
        );
    }

    // Third-party models (such as GPT) may require an AWS Marketplace subscription before first use. If the role lacks subscription permissions,
    // Converse returns AccessDeniedException and lists aws-marketplace:ViewSubscriptions and aws-marketplace:Subscribe
    // (verified on 2026-09-25 with us.openai.gpt-6-luna and gpt-6-sol). This can vary by account, so report it only when it occurs and do not cache the result.
    if (code === 'AccessDeniedException' && e.message?.includes('aws-marketplace:')) {
        return vscode.l10n.t(
            'Your AWS role cannot use this model because it lacks AWS Marketplace subscription permissions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe). Ask your AWS administrator to subscribe to the model or grant these permissions. ({0}) {1}',
            detail,
            e.message,
        );
    }
    if (isCredentialError(error)) {
        return vscode.l10n.t(
            'AWS credentials for profile "{0}" are expired or invalid. Select "Sign in", or run `aws sso login --profile {0}` in a terminal, then try again. ({1}) {2}',
            profile,
            detail,
            e.message ?? '',
        );
    }
    return vscode.l10n.t('Amazon Bedrock request failed. ({0}) {1}', detail, e.message ?? String(error));
}
