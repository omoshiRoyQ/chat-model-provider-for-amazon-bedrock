// Bundle the extension into a single dist/extension.js file with esbuild.
// VS Code provides the `vscode` module at runtime, so keep it external.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    // VS Code 1.106.0 uses Electron 37.7.0 / Node 22.20.0; remote/.npmrc also targets Node 22.20.0.
    target: 'node22',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'info',
});

if (watch) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
