/**
 * vscode module stub for unit tests (`vscode` is aliased to this file in vitest.config.ts).
 * Implements only the classes and functions used by pure-logic modules in src; constructor arguments match the VS Code API
 * so tests can create objects using the same syntax as production code.
 */

export class LanguageModelTextPart {
    constructor(public value: string) { }
}

export class LanguageModelToolCallPart {
    constructor(public callId: string, public name: string, public input: object) { }
}

export class LanguageModelToolResultPart {
    constructor(public callId: string, public content: unknown[]) { }
}

export class LanguageModelPromptTsxPart {
    constructor(public value: unknown) { }
}

export class LanguageModelDataPart {
    constructor(public data: Uint8Array, public mimeType: string) { }

    static image(data: Uint8Array, mime: string): LanguageModelDataPart {
        return new LanguageModelDataPart(data, mime);
    }
}

export class EventEmitter<T> {
    readonly event = (_listener?: (value: T) => unknown) => ({ dispose() { } });

    fire(_value?: T): void { }

    dispose(): void { }
}

export enum LanguageModelChatMessageRole {
    User = 1,
    Assistant = 2,
}

export enum LanguageModelChatToolMode {
    Auto = 1,
    Required = 2,
}

export const workspace = {
    getConfiguration(_section?: string) {
        return {
            get<T>(_key: string): T | undefined { return undefined; },
            inspect<T>(_key: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined { return undefined; },
            async update(_key: string, _value: unknown, _target?: ConfigurationTarget): Promise<void> { },
        };
    },
    onDidChangeConfiguration(_listener: unknown) {
        return { dispose() { } };
    },
};

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

export const window = {
    async showQuickPick(_items: unknown, _options?: unknown): Promise<unknown> { return undefined; },
    async showInputBox(_options?: unknown): Promise<string | undefined> { return undefined; },
    async showWarningMessage(_message: string, ..._items: string[]): Promise<string | undefined> { return undefined; },
    async showErrorMessage(_message: string, ..._items: string[]): Promise<string | undefined> { return undefined; },
    async showInformationMessage(_message: string, ..._items: string[]): Promise<string | undefined> { return undefined; },
};

export const commands = {
    async executeCommand(_command: string, ..._args: unknown[]): Promise<unknown> { return undefined; },
};

/** Matches vscode.l10n.t by replacing {0}, {1}, etc. with arguments; tests have no translation files, so it returns the English source string. */
export const l10n = {
    t(message: string, ...args: unknown[]): string {
        return message.replace(/\{(\d+)\}/g, (match, index: string) => {
            const value = args[Number(index)];
            return value === undefined ? match : String(value);
        });
    },
};
