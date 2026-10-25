// Localization check for VS Code extensions (EN source + zh-tw + ja), run before packaging.
// Canonical copy lives in the user-level `project-vscode-extension` skill; keep repo copies identical.
// Errors fail the run; warnings list calls whose message cannot be checked statically.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCALES = ['zh-tw', 'ja'];

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

function decodeEscape(text, i) {
    const c = text[i];
    if (c === 'u' && text[i + 1] === '{') {
        const end = text.indexOf('}', i);
        return [String.fromCodePoint(parseInt(text.slice(i + 2, end), 16)), end + 1];
    }
    if (c === 'u') return [String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)), i + 5];
    if (c === 'x') return [String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)), i + 3];
    if (c === '\r' && text[i + 1] === '\n') return ['', i + 2];
    if (c === '\n' || c === '\r') return ['', i + 1];
    return [SIMPLE_ESCAPES[c] ?? c, i + 1];
}

/**
 * Tokenizes TS/JS source just enough to find string literals and `l10n.t` references outside comments.
 * Returns { strings: [{value, start, end, dynamic}], calls: [index of '(' after l10n.t], aliases: [index of l10n.t not followed by '('] }.
 * Expressions inside template `${}` are scanned too. Regex literals are not recognized, so a quote inside a regex may confuse it.
 */
export function scanSource(text) {
    const strings = [];
    const calls = [];
    const aliases = [];
    // `const t = vscode.l10n.t;` makes `t(` a call; other references are reported as aliases.
    const aliasNames = [...new Set([...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:vscode\s*\.\s*)?l10n\s*\.\s*t\s*[;\n]/g)].map((m) => m[1]))];
    const aliasDeclarations = new Set([...text.matchAll(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:vscode\s*\.\s*)?(l10n\s*\.\s*t)\s*[;\n]/g)].map((m) => m.index + m[0].indexOf(m[1])));
    const aliasPattern = aliasNames.length ? `|(?:${aliasNames.map((n) => n.replace(/\$/g, '\\$')).join('|')})\\b(?=\\s*\\()` : '';
    const callee = new RegExp(`^(?:l10n\\s*\\.\\s*t\\b${aliasPattern})(\\s*\\()?`);

    // Scans from i; when inExpr is true, stops after the '}' that closes a template `${`. Returns the next index.
    const scan = (i, inExpr) => {
        let depth = 0;
        while (i < text.length) {
            const c = text[i];
            if (c === '/' && text[i + 1] === '/') {
                const end = text.indexOf('\n', i);
                i = end < 0 ? text.length : end;
                continue;
            }
            if (c === '/' && text[i + 1] === '*') {
                const end = text.indexOf('*/', i + 2);
                i = end < 0 ? text.length : end + 2;
                continue;
            }
            if (inExpr && c === '{') depth++;
            if (inExpr && c === '}') {
                if (depth === 0) return i + 1;
                depth--;
            }
            if (c === '"' || c === "'" || c === '`') {
                i = readString(i);
                continue;
            }
            const ref = callee.exec(text.slice(i, i + 80));
            // `vscode.l10n.t` may follow a dot; an alias such as `t(` must not (`obj.t(` is another function).
            if (ref && !(ref[0].startsWith('l10n') ? /[\w$]/ : /[\w$.]/).test(text[i - 1] ?? '')) {
                if (ref[1]) calls.push(i + ref[0].length - 1);
                else if (!aliasDeclarations.has(i)) aliases.push(i);
                i += ref[0].length;
                continue;
            }
            i++;
        }
        return i;
    };

    const readString = (start) => {
        const quote = text[start];
        let value = '';
        let dynamic = false;
        let i = start + 1;
        while (i < text.length && text[i] !== quote) {
            if (text[i] === '\\') {
                const [decoded, next] = decodeEscape(text, i + 1);
                value += decoded;
                i = next;
                continue;
            }
            if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
                dynamic = true;
                i = scan(i + 2, true);
                continue;
            }
            if (quote !== '`' && text[i] === '\n') break;
            value += text[i];
            i++;
        }
        strings.push({ value, start, end: i + 1, dynamic });
        return i + 1;
    };

    scan(0, false);
    strings.sort((a, b) => a.start - b.start);
    return { strings, calls, aliases };
}

/** For each l10n.t call: { line, message } when the first argument is a single plain literal, else { line, message: undefined }. */
export function l10nCalls(text) {
    const { strings, calls } = scanSource(text);
    return calls.map((paren) => {
        const line = text.slice(0, paren).split('\n').length;
        let i = paren + 1;
        while (/\s/.test(text[i])) i++;
        const literal = strings.find((s) => s.start === i);
        if (!literal || literal.dynamic) return { line, message: undefined };
        let j = literal.end;
        while (/\s/.test(text[j])) j++;
        return { line, message: text[j] === ',' || text[j] === ')' ? literal.value : undefined };
    });
}

export function placeholders(message) {
    return [...new Set(message.match(/\{\d+\}/g) ?? [])].sort().join(',');
}

function listSources(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return listSources(path);
        return /\.(m|c)?[jt]s$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
    });
}

function readJson(path, errors) {
    if (!existsSync(path)) {
        errors.push(`${path}: file is missing`);
        return {};
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        errors.push(`${path}: invalid JSON (${e.message})`);
        return {};
    }
}

function compareKeys(baseName, base, otherName, other, errors) {
    for (const key of Object.keys(base)) {
        if (!(key in other)) errors.push(`${otherName}: missing key "${key}"`);
        else if (typeof other[key] !== 'string' || other[key].trim() === '') errors.push(`${otherName}: empty value for "${key}"`);
        else if (typeof base[key] === 'string' && placeholders(base[key]) !== placeholders(other[key])) {
            errors.push(`${otherName}: placeholders differ for "${key}" (${placeholders(base[key]) || 'none'} vs ${placeholders(other[key]) || 'none'})`);
        }
    }
    for (const key of Object.keys(other)) {
        if (!(key in base)) errors.push(`${otherName}: key "${key}" is not in ${baseName}`);
    }
}

/** Returns { errors, warnings } for the extension at rootDir. */
export function checkL10n(rootDir) {
    const errors = [];
    const warnings = [];

    // Manifest strings: package.json %key% <-> package.nls*.json
    const manifestText = readFileSync(join(rootDir, 'package.json'), 'utf8');
    const nls = readJson(join(rootDir, 'package.nls.json'), errors);
    const used = new Set([...manifestText.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]));
    for (const [key, value] of Object.entries(nls)) {
        if (typeof value !== 'string' || value.trim() === '') errors.push(`package.nls.json: empty or non-string value for "${key}"`);
    }
    for (const key of used) if (!(key in nls)) errors.push(`package.nls.json: missing key "${key}" used in package.json`);
    for (const key of Object.keys(nls)) if (!used.has(key)) errors.push(`package.nls.json: key "${key}" is not used in package.json`);
    for (const locale of LOCALES) {
        compareKeys('package.nls.json', nls, `package.nls.${locale}.json`, readJson(join(rootDir, `package.nls.${locale}.json`), errors), errors);
    }

    // Runtime strings: vscode.l10n.t(...) in src <-> l10n/bundle.l10n.<locale>.json (English source is the key)
    const literals = new Set();
    const messages = new Map();
    for (const file of listSources(join(rootDir, 'src'))) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(rootDir, file).replace(/\\/g, '/');
        const scanned = scanSource(text);
        for (const s of scanned.strings) if (!s.dynamic) literals.add(s.value);
        for (const index of scanned.aliases) {
            warnings.push(`${rel}:${text.slice(0, index).split('\n').length}: l10n.t is passed or aliased; calls through it are not checked`);
        }
        for (const call of l10nCalls(text)) {
            if (call.message === undefined) warnings.push(`${rel}:${call.line}: l10n.t message is not a plain string literal; check its translations manually`);
            else if (!messages.has(call.message)) messages.set(call.message, `${rel}:${call.line}`);
        }
    }
    for (const locale of LOCALES) {
        const name = `l10n/bundle.l10n.${locale}.json`;
        const bundle = readJson(join(rootDir, name), errors);
        for (const [message, where] of messages) {
            if (!(message in bundle)) errors.push(`${name}: missing "${message}" (${where})`);
        }
        for (const [key, value] of Object.entries(bundle)) {
            if (typeof value !== 'string' || value.trim() === '') errors.push(`${name}: empty value for "${key}"`);
            else if (placeholders(key) !== placeholders(value)) errors.push(`${name}: placeholders differ for "${key}"`);
            // A key that never appears as a string literal in src cannot be reached, even through a dynamic call.
            if (!literals.has(key)) errors.push(`${name}: "${key}" does not appear as a string literal in src`);
        }
    }
    return { errors, warnings };
}

function main() {
    const rootDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    const { errors, warnings } = checkL10n(rootDir);
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (errors.length > 0) {
        console.error('L10n check FAILED:');
        for (const e of errors) console.error(`- ${e}`);
        process.exit(1);
    }
    console.log(`L10n check passed (${LOCALES.join(', ')}; ${warnings.length} dynamic calls to review manually).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
