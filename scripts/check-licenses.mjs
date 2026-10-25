// Pre-release check: every bundled production package must use an allowlisted license
// and be listed under the matching `## <SPDX>` section of THIRD-PARTY-NOTICES.md.
// Canonical copy lives in the user-level `project-vscode-extension` skill; keep repo copies identical.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.md';

/** SPDX expression: AND binds tighter than OR; malformed and unsupported expressions fail closed. */
export function isAllowed(expr) {
    if (typeof expr !== 'string' || !expr.trim()) return false;
    const tokens = [];
    for (let i = 0; i < expr.length;) {
        if (/\s/.test(expr[i])) {
            i++;
            continue;
        }
        if (expr[i] === '(' || expr[i] === ')') {
            tokens.push(expr[i++]);
            continue;
        }
        const identifier = /^[A-Za-z0-9][A-Za-z0-9.+-]*/.exec(expr.slice(i));
        if (!identifier) return false;
        tokens.push(identifier[0]);
        i += identifier[0].length;
    }

    let index = 0;
    const parsePrimary = () => {
        const token = tokens[index++];
        if (token === '(') {
            const value = parseOr();
            if (tokens[index++] !== ')') throw new Error('Unbalanced SPDX expression');
            return value;
        }
        if (!token || token === ')' || /^(AND|OR)$/i.test(token)) throw new Error('Invalid SPDX expression');
        return ALLOWED.has(token);
    };
    const parseAnd = () => {
        let value = parsePrimary();
        while (/^AND$/i.test(tokens[index] ?? '')) {
            index++;
            const right = parsePrimary();
            value = value && right;
        }
        return value;
    };
    const parseOr = () => {
        let value = parseAnd();
        while (/^OR$/i.test(tokens[index] ?? '')) {
            index++;
            const right = parseAnd();
            value = value || right;
        }
        return value;
    };

    try {
        const allowed = parseOr();
        return index === tokens.length && allowed;
    } catch {
        return false;
    }
}

/**
 * Returns Map<package name, Set<section license>>. Packages are read only inside `## <SPDX>` sections,
 * from either a "- `name`" list line or a "### name [version]" heading (used when a package needs its own notice).
 */
export function parseNotices(text) {
    const map = new Map();
    let section;
    for (const line of text.split(/\r?\n/)) {
        const heading = /^## (.+)$/.exec(line);
        if (heading) {
            section = heading[1].trim();
            continue;
        }
        const item = /^- `([^`]+)`\s*$/.exec(line) ?? /^### (\S+)(?:\s+\S+)?\s*$/.exec(line);
        if (item && section) {
            if (!map.has(item[1])) map.set(item[1], new Set());
            map.get(item[1]).add(section);
        }
    }
    return map;
}

/** Normalizes package.json license fields; unknown shapes return undefined so the check fails closed. */
export function licenseOf(pkg) {
    if (typeof pkg.license === 'string') return pkg.license;
    if (typeof pkg.license?.type === 'string') return pkg.license.type;
    if (Array.isArray(pkg.licenses) && pkg.licenses.length === 1) return pkg.licenses[0]?.type;
    return undefined;
}

/** deps: [{name, version, license}]. Returns a list of problems; empty means pass. */
export function checkLicenses(deps, notices) {
    const problems = [];
    const byName = new Map();
    for (const { name, version, license } of deps) {
        if (!isAllowed(license)) {
            problems.push(`${name}@${version}: license "${license ?? 'unknown'}" is not in the allowlist`);
        }
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(license ?? 'unknown');
    }
    for (const [name, licenses] of byName) {
        const sections = notices.get(name);
        if (!sections) {
            problems.push(`${name}: missing from ${NOTICES_FILE}`);
            continue;
        }
        for (const license of licenses) {
            if (!sections.has(license)) problems.push(`${name}: package says "${license}" but ${NOTICES_FILE} does not list it under "## ${license}"`);
        }
        for (const section of sections) {
            if (!licenses.has(section)) problems.push(`${name}: listed under "## ${section}" in ${NOTICES_FILE} but the package license is ${[...licenses].join(', ')}`);
        }
    }
    for (const name of notices.keys()) {
        if (!byName.has(name)) problems.push(`${name}: listed in ${NOTICES_FILE} but is not a production dependency`);
    }
    return problems;
}

function findPackageJson(name, fromDir) {
    for (let dir = fromDir; ; dir = dirname(dir)) {
        const candidate = join(dir, 'node_modules', name, 'package.json');
        if (existsSync(candidate)) return realpathSync(candidate);
        if (dirname(dir) === dir) return undefined;
    }
}

/** Walks dependencies and installed optionalDependencies from node_modules; works without the pnpm store index. */
export function collectProductionDeps(rootDir) {
    const root = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const seen = new Map();
    const walk = (pkg, fromDir) => {
        const required = Object.keys(pkg.dependencies ?? {});
        const optional = Object.keys(pkg.optionalDependencies ?? {});
        for (const name of [...required, ...optional]) {
            const file = findPackageJson(name, fromDir);
            if (!file) {
                if (optional.includes(name)) continue;
                throw new Error(`Cannot resolve production dependency "${name}"; run pnpm install`);
            }
            if (seen.has(file)) continue;
            const dep = JSON.parse(readFileSync(file, 'utf8'));
            seen.set(file, { name, version: dep.version, license: licenseOf(dep) });
            walk(dep, dirname(file));
        }
    };
    walk(root, rootDir);
    return [...seen.values()];
}

function main() {
    const rootDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    const deps = collectProductionDeps(rootDir);
    const noticesPath = join(rootDir, NOTICES_FILE);
    const notices = existsSync(noticesPath) ? parseNotices(readFileSync(noticesPath, 'utf8')) : new Map();
    if (!existsSync(noticesPath)) {
        console.error(`License check FAILED: ${NOTICES_FILE} is missing.`);
        process.exit(1);
    }
    const problems = checkLicenses(deps, notices);
    if (problems.length > 0) {
        console.error('License check FAILED:');
        for (const p of problems) console.error(`- ${p}`);
        console.error(`Licenses outside ${[...ALLOWED].join(', ')} need a manual compatibility review before changing the allowlist.`);
        process.exit(1);
    }
    console.log(`License check passed (${deps.length} production packages).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
