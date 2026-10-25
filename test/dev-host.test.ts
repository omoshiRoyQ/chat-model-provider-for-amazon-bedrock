import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const launcher = resolve('scripts/dev-host.mjs');

function fixture(name = 'project') {
    const directory = mkdtempSync(join(tmpdir(), 'dev-host-'));
    const root = join(directory, name);
    const bin = join(directory, 'bin');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(bin);
    copyFileSync(launcher, join(root, 'scripts/dev-host.mjs'));
    const stub = join(bin, 'code-stub.cjs');
    writeFileSync(stub, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(Number(process.env.CODE_STUB_STATUS || 0));\n');
    if (process.platform === 'win32') {
        writeFileSync(join(bin, 'code.cmd'), `@echo off\r\n"${process.execPath}" "${stub}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
        writeFileSync(join(bin, 'code'), `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exit(Number(process.env.CODE_STUB_STATUS || 0));\n`);
        chmodSync(join(bin, 'code'), 0o755);
    }
    // Replacing PATH ensures these tests cannot call an installed VS Code launcher.
    const env = { ...process.env, PATH: bin };
    return { directory, root, env };
}

describe('development host launcher', () => {
    for (const name of ['project', 'project with spaces', 'project & 100% ! (test)']) {
        it(`passes absolute extension and workspace paths from another cwd: ${name}`, () => {
            const { directory, root, env } = fixture(name);
            try {
                const result = spawnSync(process.execPath, [join(root, 'scripts/dev-host.mjs')], { cwd: directory, env, encoding: 'utf8' });
                expect(result.status, result.stderr).toBe(0);
                expect(isAbsolute(root)).toBe(true);
                expect(JSON.parse(result.stdout)).toEqual({
                    args: ['--new-window', `--extensionDevelopmentPath=${root}`, root], cwd: root,
                });
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });
    }

    it('fails for a nonzero or missing CLI', () => {
        const { directory, root, env } = fixture();
        try {
            const run = (environment: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(root, 'scripts/dev-host.mjs')], { cwd: directory, env: environment, encoding: 'utf8' });
            expect(run({ ...env, CODE_STUB_STATUS: '7' }).status).toBe(7);
            const missing = run({ ...env, PATH: directory });
            expect(missing.status).not.toBe(0);
            expect(missing.stdout).toBe('');
            expect(missing.stderr.trim()).not.toBe('');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not launch the CLI when compilation fails', () => {
        const { directory, root, env } = fixture();
        try {
            writeFileSync(join(root, 'compile.cjs'), 'console.log("compile"); process.exit(Number(process.env.COMPILE_STUB_STATUS || 0));\n');
            const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { dev: string } };
            const command = manifest.scripts.dev
                .replace('pnpm run compile', `"${process.execPath}" compile.cjs`)
                .replace('node scripts/dev-host.mjs', `"${process.execPath}" scripts/dev-host.mjs`);
            for (const status of [0, 7]) {
                const result = spawnSync(command, { shell: true, cwd: root, env: { ...env, COMPILE_STUB_STATUS: String(status) }, encoding: 'utf8' });
                expect(result.status, result.stderr).toBe(status);
                const lines = result.stdout.trim().split(/\r?\n/);
                expect(lines[0]).toBe('compile');
                expect(lines).toHaveLength(status === 0 ? 2 : 1);
                if (status === 0) {
                    expect(JSON.parse(lines[1]).args).toEqual(['--new-window', `--extensionDevelopmentPath=${root}`, root]);
                }
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});