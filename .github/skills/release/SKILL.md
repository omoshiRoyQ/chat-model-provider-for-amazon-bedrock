---
name: release
description: 'Prepare a release of this extension: set the version, finalize the three CHANGELOG files, package and inspect the VSIX. Use when bumping the version, packaging a VSIX, or preparing to publish to the VS Code Marketplace.'
---

# 發布準備

發布到 Marketplace 需要使用者同意（見 AGENTS.md「必須先經過使用者同意的動作」）。建立 commit 與 tag 由使用者執行。

## 步驟

1. 依 semver 設定 `package.json` 的 `version`：新增功能升 minor，只修錯升 patch。
2. 把 `CHANGELOG.md`、`CHANGELOG.zh-tw.md`、`CHANGELOG.ja.md` 的未發布段落改成新版本號與日期，三個檔案都要改。
3. 執行 `pnpm test`、`pnpm run compile`。
4. 封裝前詢問使用者這次的 `/security-review` 與 `/release-audit` 要由使用者自己執行、由代理執行，還是略過。使用者回答前不可封裝，也不可自行決定執行或略過。理由：兩項審查成本較高，小版本不一定需要，是否擋發布由使用者判斷（2026-10-06）。反例：沒問就直接封裝；沒問就自己跑完整審查。
5. 封裝：`pnpm run vsix`。一定要帶 `--no-dependencies`：esbuild 會將 extension 程式碼和相依套件合併輸出為單一檔案 `dist/extension.js`，而 vsce 預設用 npm 檢查 `node_modules`，和 pnpm 的目錄結構不相容。
6. 看 vsce 列出的檔案清單（不封裝、只列清單可用 `pnpm run vsix:ls`）：`.vscodeignore` 只放行 `dist/extension.js`、`package*.json`、`l10n/`、`icon.png`、README、LICENSE、THIRD-PARTY-NOTICES、CHANGELOG；確認沒有 `src`、`test`、`node_modules`。（2026-09-26 實測）
7. 請使用者安裝封裝出來的 VSIX 實際操作，測試清單用 `test-scenarios` skill 產生。F5 能用不代表 VSIX 能用，因為 esbuild 合併輸出時可能遺漏相依套件。
