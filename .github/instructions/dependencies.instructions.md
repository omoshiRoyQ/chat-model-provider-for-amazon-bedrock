---
description: "Use when adding, upgrading, or removing npm dependencies, approving pnpm build scripts, or updating THIRD-PARTY-NOTICES and license checks."
applyTo: "package.json, pnpm-workspace.yaml, pnpm-lock.yaml, THIRD-PARTY-NOTICES.md, scripts/check-third-party-notices.mjs"
---

# 相依套件與授權

- pnpm 預設禁止相依套件執行 build script，esbuild 已在 `pnpm-workspace.yaml` 的 `allowBuilds` 允許。之後新增的套件如果需要 build script，`pnpm install` 會以 `ERR_PNPM_IGNORED_BUILDS` 失敗，要先問使用者，再用 `pnpm approve-builds <pkg>` 加入。不可用 `--all` 一次全部允許。理由：build script 能執行任意程式，屬於供應鏈風險。
- `@vscode/vsce-sign` 在 `allowBuilds` 設為 `false`：它是 vsce 的簽章工具，安裝腳本會下載執行檔，但 `vsce package` 不需要它（2026-09-26 實測）。發布時如果需要簽章，先問使用者再改。
- 新增、升級或移除 production dependency 時，要更新 [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) 的套件清單、授權全文與上游版權聲明。
- esbuild 會打包 runtime imports，不會依 `dependencies` 或 `devDependencies` 分類；目前 devDependencies 沒有被 extension runtime 匯入。若 devDependency 改為 runtime import，必須移入 `dependencies` 並納入 notices。
- `pnpm run check-licenses` 只確認 `pnpm licenses list --prod --json` 回報的授權識別字都在允許清單，且每個 production 套件名稱字串都出現在 THIRD-PARTY-NOTICES.md。它不會驗證套件是否列在正確授權章節、授權全文或上游版權聲明；這些仍須人工對照上游授權檔。`pnpm run package`／`pnpm run vsix` 都會先執行檢查。授權識別字不在允許清單（MIT、Apache-2.0、0BSD）時，檢查會失敗並列出套件名稱；必須先人工判斷授權相容性與散布條件，不可自行擴充允許清單。
