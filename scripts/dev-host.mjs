import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const options = { cwd: root, stdio: 'inherit' };
// code is a .cmd launcher on Windows; expand the quoted path once, without interpolating it into shell syntax.
const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', [
        '/d', '/v:off', '/s', '/c',
        'code --new-window "--extensionDevelopmentPath=%DEV_HOST_ROOT%" "%DEV_HOST_ROOT%"',
    ], { ...options, windowsVerbatimArguments: true, env: { ...process.env, DEV_HOST_ROOT: root } })
    : spawnSync('code', ['--new-window', `--extensionDevelopmentPath=${root}`, root], options);

if (result.error) console.error(`Could not launch Extension Development Host: ${result.error.message}`);
process.exitCode = result.status ?? 1;