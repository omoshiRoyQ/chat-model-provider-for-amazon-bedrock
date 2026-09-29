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
    onDidChangeConfiguration(_listener: unknown) {
        return { dispose() { } };
    },
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
