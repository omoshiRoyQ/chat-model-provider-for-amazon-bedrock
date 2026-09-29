// Pre-release check: production packages must use allowlisted license identifiers and appear in THIRD-PARTY-NOTICES.md.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The notices file carries full texts for these license types; unfamiliar identifiers require manual compatibility review before changing the allowlist or notices.
const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', '0BSD'];
const NOTICES_PATH = new URL('../THIRD-PARTY-NOTICES.md', import.meta.url);

const raw = execSync('pnpm licenses list --prod --json', { encoding: 'utf8' });
const licensesByType = JSON.parse(raw);
const notices = readFileSync(NOTICES_PATH, 'utf8');

const unknownLicenses = [];
const missingFromNotices = [];

for (const [license, packages] of Object.entries(licensesByType)) {
    if (!ALLOWED_LICENSES.includes(license)) {
        unknownLicenses.push({ license, names: packages.map((p) => p.name) });
        continue;
    }
    for (const pkg of packages) {
        if (!notices.includes(pkg.name)) {
            missingFromNotices.push(`${pkg.name} (${license})`);
        }
    }
}

if (unknownLicenses.length > 0 || missingFromNotices.length > 0) {
    console.error('第三方授權檢查失敗：');
    for (const { license, names } of unknownLicenses) {
        console.error(`  - 授權 "${license}" 不在允許清單（${ALLOWED_LICENSES.join('、')}）：${names.join(', ')}`);
        console.error('    請先確認此授權是否相容於 MIT 專案的重新散布，再決定是否加入允許清單。');
    }
    for (const entry of missingFromNotices) {
        console.error(`  - THIRD-PARTY-NOTICES.md 未列出：${entry}`);
    }
    console.error('請更新 THIRD-PARTY-NOTICES.md 後再重新執行。');
    process.exit(1);
}

const total = Object.values(licensesByType).reduce((sum, list) => sum + list.length, 0);
console.log(`第三方授權檢查通過：共 ${total} 個 production 套件，授權識別字都在允許清單，且名稱都列在 THIRD-PARTY-NOTICES.md。`);
