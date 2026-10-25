import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const placeholders = (value: string) => [...new Set(value.match(/\{\d+\}/g) ?? [])].sort();

describe('extension manifest and localization contract', () => {
    it('keeps the release version and translated changelog structure in sync', () => {
        const { version } = readJson<{ version: string }>('package.json');
        const changelogs = ['CHANGELOG.md', 'CHANGELOG.zh-tw.md', 'CHANGELOG.ja.md'].map((path) => readFileSync(path, 'utf8'));
        const latestEntries = changelogs.map((content) => {
            const lines = content.split(/\r?\n/);
            const start = lines.findIndex((line) => /^## \d+\.\d+\.\d+/.test(line));
            const headingVersion = /^## (\d+\.\d+\.\d+)/.exec(lines[start] ?? '')?.[1];
            const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
            const bullets = lines.slice(start + 1, next === -1 ? undefined : next).filter((line) => /^- /.test(line)).length;
            return { version: headingVersion, bullets };
        });

        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(latestEntries.map(({ version: entryVersion }) => entryVersion)).toEqual([version, version, version]);
        expect(latestEntries[0]?.bullets).toBeGreaterThan(0);
        expect(latestEntries.map(({ bullets }) => bullets)).toEqual(latestEntries.map(() => latestEntries[0]!.bullets));
    });

    it('orders provider settings exactly as specified for the Settings UI', () => {
        const manifest = readJson<{ contributes: { configuration: { properties: Record<string, { order?: number }> } } }>('package.json');
        const properties = manifest.contributes.configuration.properties;
        const expected = [
            'amazonBedrockProvider.profile',
            'amazonBedrockProvider.region',
            'amazonBedrockProvider.inferenceScope',
            'amazonBedrockProvider.modelVisibility',
            'amazonBedrockProvider.modelPresets',
            'amazonBedrockProvider.usageResetDay',
            'amazonBedrockProvider.usageResetHour',
            'amazonBedrockProvider.customPricing',
        ];
        const actual = Object.entries(properties)
            .filter(([key]) => key.startsWith('amazonBedrockProvider.'))
            .sort(([, left], [, right]) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
            .map(([key]) => key);

        expect(actual).toEqual(expected);
        expect(expected.map((key) => properties[key]?.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('keeps all user-facing commands in the provider category with stable IDs', () => {
        const manifest = readJson<{ contributes: { commands: { command: string; title: string; category: string }[] } }>('package.json');
        const english = readJson<Record<string, string>>('package.nls.json');
        const taiwan = readJson<Record<string, string>>('package.nls.zh-tw.json');
        const japanese = readJson<Record<string, string>>('package.nls.ja.json');
        const expected = [
            ['amazonBedrockProvider.showLogs', 'command.showLogs.title'],
            ['amazonBedrockProvider.signIn', 'command.signIn.title'],
            ['amazonBedrockProvider.showUsage', 'command.showUsage.title'],
            ['amazonBedrockProvider.pickThinkingEffort', 'command.pickThinkingEffort.title'],
            ['amazonBedrockProvider.pickModelVisibility', 'command.pickModelVisibility.title'],
            ['amazonBedrockProvider.manageModelPresets', 'command.manageModelPresets.title'],
        ];

        expect(manifest.contributes.commands.map(({ command, title }) => [command, title])).toEqual(expected.map(([id, key]) => [id, `%${key}%`]));
        for (const command of manifest.contributes.commands) {
            expect(command.category).toBe('%command.category%');
        }
        expect(english['command.category']).toBeTruthy();
        expect(taiwan['command.category']).toBe(english['command.category']);
        expect(japanese['command.category']).toBe(english['command.category']);
        expect(taiwan['command.showLogs.title']).toContain('顯示紀錄');
        expect(taiwan['command.signIn.title']).toContain('登入');
        expect(japanese['command.showLogs.title']).toBe('ログを表示');
        expect(japanese['command.signIn.title']).toContain('サインイン');

        for (const locale of ['zh-tw', 'ja']) {
            const translation = readJson<Record<string, string>>(`package.nls.${locale}.json`);
            expect(Object.keys(translation).sort()).toEqual(Object.keys(english).sort());
            for (const key of Object.keys(english)) {
                expect(placeholders(translation[key])).toEqual(placeholders(english[key]));
            }
        }
    });

    it('keeps shared runtime terms and the approved Default exception in both bundles', () => {
        const taiwan = readJson<Record<string, string>>('l10n/bundle.l10n.zh-tw.json');
        const japanese = readJson<Record<string, string>>('l10n/bundle.l10n.ja.json');

        expect(taiwan['Show Logs']).toBe('顯示紀錄');
        expect(taiwan['Sign in']).toBe('登入');
        expect(taiwan['Reset']).toBe('重設');
        expect(japanese['Show Logs']).toBe('ログを表示');
        expect(japanese['Sign in']).toBe('サインイン');
        expect(japanese['Reset']).toBe('リセット');
        for (const bundle of [taiwan, japanese]) {
            expect(bundle['Default']).toBe('Default');
            expect(bundle['Reset all models to Default']).toContain('Default');
            expect(bundle['Reset all saved thinking effort values to Default for every Bedrock model?']).toContain('Default');
        }
        expect(Object.keys(taiwan).sort()).toEqual(Object.keys(japanese).sort());
        for (const key of Object.keys(taiwan)) {
            expect(placeholders(taiwan[key])).toEqual(placeholders(key));
            expect(placeholders(japanese[key])).toEqual(placeholders(key));
        }
    });

    /** The user requires explicit precedence over defaults, independent all/empty selection and three version families; the old modelFilter setting was removed (2026-10-25). */
    it('declares a complete window-scoped visibility object without the removed modelFilter', () => {
        const manifest = readJson<{ contributes: { configuration: { properties: Record<string, any> } } }>('package.json');
        const properties = manifest.contributes.configuration.properties;
        const schema = properties['amazonBedrockProvider.modelVisibility'];
        expect(schema).toMatchObject({ type: 'object', scope: 'window', order: 4, additionalProperties: false, required: ['mode', 'providers'] });
        expect(schema.default).toEqual({ mode: 'selected', providers: ['anthropic', 'openai'], minimumVersions: {} });
        expect(schema.properties.mode.enum).toEqual(['all', 'selected']);
        expect(schema.properties.providers).toMatchObject({ type: 'array', uniqueItems: true });
        expect(schema.properties.providers.items.enum).toContain('other');
        expect(schema.properties.minimumVersions.additionalProperties).toBe(false);
        expect(Object.keys(schema.properties.minimumVersions.properties)).toEqual(['claude', 'gpt', 'grok']);
        for (const family of ['claude', 'gpt', 'grok']) {
            const pattern = new RegExp(schema.properties.minimumVersions.properties[family].pattern);
            expect(pattern.test('6')).toBe(true);
            expect(pattern.test('4.6')).toBe(true);
            expect(pattern.test('6\n')).toBe(false);
            expect(pattern.test('6\r')).toBe(false);
        }
        expect(properties['amazonBedrockProvider.modelFilter']).toBeUndefined();
    });

    /** The user's confirmed preset contract: no stored name, stored route, window scope, empty default. */
    it('declares the model presets array with id, modelId, route and effort only', () => {
        const manifest = readJson<{ contributes: { configuration: { properties: Record<string, any> } } }>('package.json');
        const schema = manifest.contributes.configuration.properties['amazonBedrockProvider.modelPresets'];
        expect(schema).toMatchObject({ type: 'array', scope: 'window', order: 5, default: [] });
        expect(schema.items).toMatchObject({ type: 'object', additionalProperties: false, required: ['id', 'modelId', 'route', 'effort'] });
        expect(Object.keys(schema.items.properties)).toEqual(['id', 'modelId', 'route', 'effort']);
        expect(schema.items.properties.route.enum).toEqual(['Geo', 'Global', 'In-Region']);
        expect(schema.items.properties.effort.enum).toEqual(['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('keeps the development script and task contract without duplicate compilation', () => {
        const manifest = readJson<{ scripts: Record<string, string> }>('package.json');
        const taskConfig = readJson<{
            tasks: {
                label: string;
                type: string;
                command: string;
                group?: string | { kind: string; isDefault?: boolean };
                options?: { cwd?: string };
                presentation?: { reveal?: string };
                dependsOn?: string | string[];
                problemMatcher?: string[];
            }[]
        }>(`.vscode/tasks.json`);
        const scripts = manifest.scripts;
        const defaultTasks = taskConfig.tasks.filter((task) => typeof task.group === 'object' && task.group.isDefault === true);
        const hostTask = taskConfig.tasks.find((task) => task.label === 'Open Extension Development Host');
        const compileTask = taskConfig.tasks.find((task) => task.label === 'pnpm: compile');
        const compileDependencies = taskConfig.tasks.flatMap((task) => task.dependsOn === undefined
            ? []
            : Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn]);

        expect(Object.keys(scripts)).toHaveLength(15);
        expect(scripts.dev).toBe('pnpm run compile && node scripts/dev-host.mjs');
        expect((scripts.dev.match(/pnpm run compile/g) ?? [])).toHaveLength(1);
        expect(scripts.typecheck).toBe('tsc --noEmit && tsc -p tsconfig.test.json');
        expect(scripts.compile).toBe('pnpm run typecheck && node esbuild.mjs');
        expect(scripts['check-model-cards']).toBeTruthy();
        expect(scripts['probe-models']).toBeTruthy();
        expect(scripts.check).not.toMatch(/check-model-cards|probe-models/);
        expect(scripts.verify).not.toMatch(/check-model-cards|probe-models/);

        expect(defaultTasks).toHaveLength(1);
        expect(defaultTasks[0]?.label).toBe('Open Extension Development Host');
        expect(defaultTasks[0]?.group).toMatchObject({ kind: 'build', isDefault: true });
        expect(taskConfig.tasks[0]?.label).toBe('Open Extension Development Host');
        expect(hostTask).toMatchObject({
            type: 'shell',
            command: 'pnpm run dev',
            options: { cwd: '${workspaceFolder}' },
            group: { kind: 'build', isDefault: true },
            presentation: { reveal: 'always' },
            problemMatcher: [],
        });
        expect(hostTask).not.toHaveProperty('args');
        expect(hostTask).not.toHaveProperty('dependsOn');
        expect(compileDependencies).not.toContain('pnpm: compile');
        expect(compileTask).toMatchObject({
            type: 'shell',
            command: 'pnpm run compile',
            group: 'build',
            problemMatcher: ['$tsc'],
        });
        expect(compileTask).not.toHaveProperty('dependsOn');
    });

    /** The user's packaging requirement: tests and prepublish checks run once before a VSIX, without AWS probes or publishing. */
    it('provides one verified packaging entry point while preserving non-packaging verification', () => {
        const { scripts } = readJson<{ scripts: Record<string, string> }>('package.json');
        expect(scripts['package:verified']).toBe('pnpm run test && pnpm run package && pnpm run package:ls');
        expect(scripts.package).toBe('vsce package --no-dependencies');
        expect(scripts['vscode:prepublish']).toBe('pnpm run typecheck && pnpm run check && node esbuild.mjs --production');
        expect(scripts.check).toBe('pnpm run check:licenses && pnpm run check:l10n');
        expect(scripts.verify).toBe('pnpm run compile && pnpm test && pnpm run check && pnpm run package:ls');
        expect(scripts['package:verified']).not.toMatch(/verify|compile|probe-models|check-model-cards|publish|install/);
    });
});