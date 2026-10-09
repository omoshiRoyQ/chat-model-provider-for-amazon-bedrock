import { describe, expect, it } from 'vitest';
import { describeError, describeErrorForLog, isCredentialError, isSystemMessageUnsupported, withOperationContext } from '../src/errors';

/**
 * Expected values come from AGENTS.md (errors include the model ID, call path, and AWS error code; expired SSO prompts for aws sso login)
 * and AWS errors observed on 2026-09-25 and 26.
 */

function awsError(name: string, message: string, httpStatusCode?: number): Error {
    const error = new Error(message);
    error.name = name;
    Object.assign(error, { $metadata: { httpStatusCode, requestId: 'req-1' } });
    return error;
}

describe('isSystemMessageUnsupported', () => {
    it('辨識 Mistral 7B Instruct 實測回傳的訊息（2026-10-01）', () => {
        const message = "This model doesn't support system messages. Try again without a system message or use a model that supports system messages.";
        expect(isSystemMessageUnsupported(awsError('ValidationException', message, 400))).toBe(true);
        expect(isSystemMessageUnsupported(awsError('ValidationException', 'bad request', 400))).toBe(false);
        expect(isSystemMessageUnsupported(awsError('AccessDeniedException', message, 403))).toBe(false);
    });
});

describe('describeError', () => {
    it('一般錯誤包含 model ID、呼叫路徑、錯誤碼、HTTP 狀態碼與原始訊息', () => {
        const message = describeError(awsError('ValidationException', 'bad request', 400), 'us.x', 'Native', 'dev');
        for (const part of ['model=us.x', 'path=Native', 'code=ValidationException', 'http=400', 'requestId=req-1', 'bad request']) {
            expect(message).toContain(part);
        }
    });

    it('SSO 過期時提示 aws sso login 並帶 profile 名稱', () => {
        // Observed message thrown by fromIni when not signed in (2026-09-26).
        const error = awsError('CredentialsProviderError', "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.");
        expect(isCredentialError(error)).toBe(true);
        const message = describeError(error, 'us.x', 'Native', 'dev');
        expect(message).toContain('Select "Sign in"');
        expect(message).toContain('aws sso login --profile dev');
        expect(message).toContain('code=CredentialsProviderError');
    });

    it('缺少 Marketplace 訂閱權限時說明需要的權限', () => {
        // Observed message when invoking us.openai.gpt-6-luna (2026-09-26).
        const error = awsError(
            'AccessDeniedException',
            'Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe) to enable access to this model.',
            403,
        );
        const message = describeError(error, 'us.openai.gpt-6-luna', 'Native', 'dev');
        expect(message).toContain('AWS Marketplace subscription permissions');
        expect(message).toContain('model=us.openai.gpt-6-luna');
    });

    it('一般的 AccessDeniedException 不當成 Marketplace 或 credential 問題', () => {
        const error = awsError('AccessDeniedException', 'not authorized to perform bedrock:InvokeModel', 403);
        expect(isCredentialError(error)).toBe(false);
        expect(describeError(error, 'm', 'Native', 'dev')).toMatch(/^Amazon Bedrock request failed/);
    });

    it('不是 Error 的值也能產生訊息', () => {
        expect(describeError(undefined, 'm', 'Native', 'dev')).toContain('code=UnknownError');
    });

    it('使用者看到的錯誤訊息也會遮蔽 principal ARN 與 email', () => {
        // Same AccessDenied message shape as the ListInferenceProfiles case below.
        const raw = 'User: arn:aws:sts::123456789012:assumed-role/Test/user.name@example.com is not authorized to perform: bedrock:InvokeModel';
        const message = describeError(awsError('AccessDeniedException', raw, 403), 'us.x', 'Native', 'dev');
        expect(message).toContain('[AWS principal redacted]');
        expect(message).toContain('bedrock:InvokeModel');
        expect(message).not.toContain('arn:aws:');
        expect(message).not.toContain('user.name@example.com');
    });

    it('region 無法解析時提示 VS Code 設定與 AWS profile', () => {
        const error = withOperationContext(new Error('Region is missing'), 'ResolveRegion');
        const message = describeError(error, 'model list', 'Native', 'BedrockX');
        const logMessage = describeErrorForLog(error, 'model list', 'Native', 'BedrockX');

        expect(message).toContain('No AWS Region is configured');
        expect(message).toContain('amazonBedrockProvider.region');
        expect(message).toContain('AWS profile "BedrockX"');
        expect(message).not.toContain('ListInferenceProfiles');
        expect(logMessage).toContain('No AWS Region is configured');
        expect(logMessage).toContain('code=RegionNotConfigured');
        expect(logMessage).not.toContain('Region is missing');
    });

    it('ListInferenceProfiles 遭拒時指出 IAM action、region 與 AWS request ID', () => {
        const rawMessage = 'User: arn:aws:sts::123456789012:assumed-role/Test/user.name@example.com is not authorized to perform: bedrock:ListInferenceProfiles';
        const error = withOperationContext(awsError('AccessDeniedException', rawMessage, 403), 'ListInferenceProfiles', 'us-west-2');
        const message = describeError(error, 'model list', 'Native', 'BedrockX');
        const logMessage = describeErrorForLog(error, 'model list', 'Native', 'BedrockX');

        expect(message).toContain('bedrock:ListInferenceProfiles');
        expect(message).toContain('us-west-2');
        expect(message).toContain('BedrockX');
        expect(message).toContain('http=403');
        expect(message).toContain('requestId=req-1');
        expect(message).not.toContain('arn:aws:');
        expect(message).not.toContain('user.name@example.com');
        expect(logMessage).toContain('lacks bedrock:ListInferenceProfiles permission');
        expect(logMessage).toContain('operation=ListInferenceProfiles');
        expect(logMessage).toContain('region=us-west-2');
        expect(logMessage).toContain('requestId=req-1');
        expect(logMessage).not.toContain('arn:aws:');
        expect(logMessage).not.toContain('user.name@example.com');
    });

    it('其他 AWS log 錯誤會遮蔽 principal ARN 與 email', () => {
        const error = awsError(
            'AccessDeniedException',
            'User: arn:aws:sts::123456789012:assumed-role/Test/user.name@example.com is denied',
            403,
        );
        const message = describeErrorForLog(error, 'global.x', 'Native', 'dev');

        expect(message).toContain('[AWS principal redacted]');
        expect(message).not.toContain('arn:aws:');
        expect(message).not.toContain('user.name@example.com');
    });
});

describe('describeErrorForLog', () => {
    it('returns English diagnostics independently of the localized user-facing error', () => {
        const error = awsError('CredentialsProviderError', 'Token expired.');
        expect(describeErrorForLog(error, 'global.x', 'Native', 'dev')).toBe(
            'AWS credentials for profile "dev" are expired or invalid. (model=global.x, path=Native, code=CredentialsProviderError, requestId=req-1) Token expired.',
        );
    });
});
