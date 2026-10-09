import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { redactAwsIdentity } from './errors';

/** Hides OAuth query values (client_id, state, PKCE challenge), the organization's Start URL subdomain, and emails. */
export function redactSignInOutput(line: string): string {
    return redactAwsIdentity(line)
        .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?[redacted]')
        .replace(/https:\/\/[^\s/.]+\.awsapps\.com/g, 'https://[redacted].awsapps.com');
}

/**
 * Runs `aws sso login --profile <name>` through the AWS CLI.
 *
 * The AWS CLI handles browser authorization and writes the token to `~/.aws/sso/cache/`;
 * the SDK's `fromIni({ profile })` then reads the new token. The extension never reads or writes token files.
 * Run this only when the user selects Sign in; do not trigger it in the background and open a browser unexpectedly.
 *
 * Run aws directly with child_process (`shell: false`) and pass arguments as an array. The shell does not parse the profile name as a command.
 */
export class SsoSignIn {
    private running: Promise<boolean> | undefined;

    constructor(private readonly log: vscode.LogOutputChannel) { }

    /** Return the same Promise while a sign-in is in progress to avoid opening duplicate browser sessions. The result indicates success. */
    run(profile: string): Promise<boolean> {
        if (!this.running) {
            this.running = this.execute(profile).finally(() => {
                this.running = undefined;
            });
        }
        return this.running;
    }

    private execute(profile: string): Promise<boolean> {
        return Promise.resolve(
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: vscode.l10n.t('Signing in to AWS SSO (profile "{0}"). Complete the sign-in in your browser.', profile),
                    cancellable: true,
                },
                (_progress, token) =>
                    new Promise<boolean>((resolve) => {
                        this.log.info(`Running aws sso login --profile ${profile}`);
                        // On Windows, spawn looks for aws.exe in the cwd before PATH (verified with Node 24.19); use the home directory so a project folder is never searched.
                        const child = spawn('aws', ['sso', 'login', '--profile', profile], { shell: false, windowsHide: true, cwd: homedir() });
                        const forward = (chunk: Buffer) => {
                            for (const line of chunk.toString('utf8').split(/\r?\n/)) {
                                if (line.trim()) {
                                    this.log.info(`[aws sso login] ${redactSignInOutput(line)}`);
                                }
                            }
                        };
                        child.stdout.on('data', forward);
                        child.stderr.on('data', forward);
                        const cancel = token.onCancellationRequested(() => {
                            this.log.info('User cancelled aws sso login');
                            child.kill();
                        });
                        child.on('error', (error: NodeJS.ErrnoException) => {
                            cancel.dispose();
                            if (error.code === 'ENOENT') {
                                this.log.error('AWS CLI (aws) was not found; automatic sign-in is unavailable');
                                void vscode.window.showErrorMessage(
                                    vscode.l10n.t('AWS CLI was not found. Install AWS CLI v2, or run `aws sso login --profile {0}` yourself.', profile),
                                );
                            } else {
                                this.log.error(`Failed to run aws sso login: ${error.message}`);
                            }
                            resolve(false);
                        });
                        child.on('close', (code) => {
                            cancel.dispose();
                            this.log.info(`aws sso login ended, exit code=${code}`);
                            resolve(code === 0);
                        });
                    }),
            ),
        );
    }
}
