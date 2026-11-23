import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { redactSignInOutput, SsoSignIn } from '../src/signIn';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('vscode', async (importOriginal) => {
    const vscode = await importOriginal<typeof import('vscode')>();
    return {
        ...vscode,
        ProgressLocation: { Notification: 15 },
        window: {
            ...vscode.window,
            withProgress: (_options: vscode.ProgressOptions, task: (progress: unknown, token: vscode.CancellationToken) => Promise<unknown>) =>
                task(undefined, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
        },
    };
});

describe('SsoSignIn.run', () => {
    it('拒絕以 - 開頭的 profile 名稱，不啟動 aws', async () => {
        const log = { error: vi.fn(), info: vi.fn() } as unknown as vscode.LogOutputChannel;
        await expect(new SsoSignIn(log).run('--endpoint-url=https://example.invalid')).resolves.toBe(false);
        expect(log.error).toHaveBeenCalledOnce();
        expect(log.info).not.toHaveBeenCalled();
    });

    it('redacts complete lines from both streams, even across chunks', async () => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
        vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
        const info = vi.fn();
        const log = { info } as unknown as vscode.LogOutputChannel;
        const result = new SsoSignIn(log).run('sample-profile');
        const prefix = '[aws sso login] ';
        const loggedLines = () => info.mock.calls.map(([message]) => message).filter((message) => message.startsWith(prefix));
        // Use the AWS CLI output formats below with synthetic values.
        const text = '臺かなe\u0301🙂';
        const bytes = Buffer.from(text);
        child.stdout.write('https://login.example/authorize?state=sample-');
        child.stderr.write('ABCD-');
        child.stdout.write('value\r');
        expect(loggedLines()).toEqual([]);
        const stdoutEnded = once(child.stdout, 'end');
        const stderrEnded = once(child.stderr, 'end');
        child.stdout.write(Buffer.concat([Buffer.from('\n\n'), bytes.subarray(0, bytes.length - 2)]));
        child.stdout.end(bytes.subarray(bytes.length - 2));
        child.stderr.end('1234');
        await Promise.all([stdoutEnded, stderrEnded]);
        child.emit('close', 0);

        await expect(result).resolves.toBe(true);
        expect(loggedLines().sort()).toEqual([
            `${prefix}https://login.example/authorize?[redacted]`,
            `${prefix}[code redacted]`,
            `${prefix}${text}`,
        ].sort());
    });
});

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

    // Device-authorization output format from https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html (code is the docs' sample).
    it('遮蔽裝置授權的一次性代碼，保留提示文字', () => {
        expect(redactSignInOutput('QCFK-N451')).toBe('[code redacted]');
        expect(redactSignInOutput('Then enter the code:')).toBe('Then enter the code:');
    });

    it('一般說明文字維持原樣', () => {
        const line = "If you are unable to open the URL on this device, run this command again with the '--use-device-code' option.";
        expect(redactSignInOutput(line)).toBe(line);
    });
});
