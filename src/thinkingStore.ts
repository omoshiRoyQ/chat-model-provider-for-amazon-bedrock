import type * as vscode from 'vscode';
import { THINKING_EFFORTS, type ThinkingEffort } from './thinking';

const KEY = 'thinkingEffortByModel';

/**
 * Stores each model's thinking effort in globalState. The key is the invocation model ID, including prefixes such as us. and global.
 * Models without a stored value use default (no thinking parameters are sent).
 */
export class ThinkingStore {
    constructor(private readonly memento: vscode.Memento) { }

    get(modelId: string): ThinkingEffort {
        const value = this.memento.get<Record<string, string>>(KEY, {})[modelId];
        return THINKING_EFFORTS.includes(value as ThinkingEffort) ? (value as ThinkingEffort) : 'default';
    }

    async set(modelId: string, effort: ThinkingEffort): Promise<void> {
        const all = { ...this.memento.get<Record<string, string>>(KEY, {}) };
        if (effort === 'default') {
            delete all[modelId];
        } else {
            all[modelId] = effort;
        }
        await this.memento.update(KEY, all);
    }

    async resetAll(): Promise<void> {
        await this.memento.update(KEY, {});
    }
}
