import { describe, expect, it } from 'vitest';
import { redactSignInOutput } from '../src/signIn';

// Line formats observed in this extension's log from AWS CLI v2 `aws sso login` (2026-10-01); IDs replaced with dummies.
describe('redactSignInOutput', () => {
    it('移除授權網址的查詢參數，保留 host 與路徑', () => {
        const line = 'https://oidc.ap-southeast-1.amazonaws.com/authorize?response_type=code&client_id=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A50949%2Foauth%2Fcallback&state=s-1&code_challenge_method=S256&scopes=sso%3Aaccount%3Aaccess&code_challenge=c-1';
        expect(redactSignInOutput(line)).toBe('https://oidc.ap-southeast-1.amazonaws.com/authorize?[redacted]');
    });

    it('遮蔽 Start URL 的組織子網域', () => {
        expect(redactSignInOutput('Successfully logged into Start URL: https://example-org.awsapps.com/start'))
            .toBe('Successfully logged into Start URL: https://[redacted].awsapps.com/start');
    });

    it('一般說明文字維持原樣', () => {
        const line = "If you are unable to open the URL on this device, run this command again with the '--use-device-code' option.";
        expect(redactSignInOutput(line)).toBe(line);
    });
});
