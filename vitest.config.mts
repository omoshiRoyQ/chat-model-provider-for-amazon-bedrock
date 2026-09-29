import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // Unit tests run outside the Extension Host, where the vscode module is unavailable; use the test stub instead.
        alias: {
            vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)),
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
    },
});
