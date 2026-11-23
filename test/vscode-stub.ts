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

    static text(value: string, mime = 'text/plain'): LanguageModelDataPart {
        return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
    }

    static json(value: unknown, mime = 'application/json'): LanguageModelDataPart {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError('Value cannot be serialized as JSON.');
        }
        return new LanguageModelDataPart(new TextEncoder().encode(serialized), mime);
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
    fs: {
        async readFile(_uri: unknown): Promise<Uint8Array> { throw Object.assign(new Error('not found'), { code: 'FileNotFound' }); },
        async writeFile(_uri: unknown, _content: Uint8Array): Promise<void> { },
        async rename(_source: unknown, _target: unknown, _options?: unknown): Promise<void> { },
        async createDirectory(_uri: unknown): Promise<void> { },
        async delete(_uri: unknown): Promise<void> { },
    },
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

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
}

export class ThemeColor {
    constructor(public id: string) { }
}

export const Uri = {
    file(fsPath: string) {
        return { scheme: 'file', fsPath };
    },
    joinPath(base: { scheme: string; path: string; with(change: { path: string }): unknown }, ...segments: string[]) {
        return base.with({ path: [base.path.replace(/\/+$/, ''), ...segments].join('/') });
    },
};

export const env = {
    language: 'en',
};

export const window = {
    createOutputChannel(_name: string, _options?: unknown) {
        return { info() { }, warn() { }, error() { }, show() { }, dispose() { } };
    },
    createStatusBarItem(_id?: string, _alignment?: StatusBarAlignment, _priority?: number) {
        return { name: '', text: '', tooltip: '', command: '', backgroundColor: undefined as unknown, show() { }, hide() { }, dispose() { } };
    },
    createWebviewPanel(_viewType: string, _title: string, _showOptions: unknown, _options?: unknown) {
        return {
            reveal() { },
            onDidDispose() { return { dispose() { } }; },
            dispose() { },
            webview: { cspSource: 'vscode-webview:', html: '', onDidReceiveMessage() { return { dispose() { } }; } },
        };
    },
    async withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
        return task();
    },
    async showQuickPick(_items: unknown, _options?: unknown): Promise<unknown> { return undefined; },
    async showInputBox(_options?: unknown): Promise<string | undefined> { return undefined; },
    async showWarningMessage(_message: string, ..._items: unknown[]): Promise<string | undefined> { return undefined; },
    async showErrorMessage(_message: string, ..._items: string[]): Promise<string | undefined> { return undefined; },
    async showInformationMessage(_message: string, ..._items: string[]): Promise<string | undefined> { return undefined; },
};

export const lm = {
    registerLanguageModelChatProvider(_vendor: string, _provider: unknown) {
        return { dispose() { } };
    },
};

export const commands = {
    registerCommand(_command: string, _callback: (...args: unknown[]) => unknown) {
        return { dispose() { } };
    },
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
