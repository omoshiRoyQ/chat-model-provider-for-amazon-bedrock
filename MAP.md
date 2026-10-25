# chat-model-provider-for-amazon-bedrock Map

最後核對：2026-10-25，核對對象：專案根目錄、.github、.vscode、scripts／src／test 檔案職責

## File Map

- `AGENTS.md`：權限、建置／測試／驗證規則與已確認的安全及語系例外。
- `package.json`：manifest、貢獻點、設定 schema（含 `order`）、pnpm scripts。
- `pnpm-workspace.yaml`、`pnpm-lock.yaml`：安裝建置核准與相依鎖定。
- `.vscodeignore`：VSIX 內容白名單。
- `esbuild.mjs`：extension bundle 建置。
- `tsconfig.json`、`tsconfig.test.json`、`vitest.config.mts`：型別檢查與 Vitest 設定。
- `.vscode/tasks.json`：預設 Extension Development Host 與獨立編譯 task。
- `.github/instructions/pricing.instructions.md`：費用估算規則。
- `.github/skills/update-catalog/`：模型目錄更新流程。
- `scripts/dev-host.mjs`：啟動 Extension Development Host。
- `scripts/check-licenses.mjs`、`scripts/check-l10n.mjs`：封裝前授權及語系檢查。
- `scripts/check-model-cards.mts`、`scripts/probe-models.mts`：模型卡檢查與能力探測。
- `src/extension.ts`：啟用、provider／命令／狀態列註冊、設定變更處理。
- `src/provider.ts`：Chat provider、模型清單生命週期、固定模型組合展開、請求處理。
- `src/native.ts`：Native ConverseStream 呼叫與串流事件。
- `src/convert.ts`：訊息、system、工具、圖片與 prompt cache 轉換。
- `src/models.ts`：內建模型目錄、能力資料、模型解析。
- `src/modelList.ts`、`src/modelListCore.mjs`、`src/modelListCore.d.mts`：模型來源載入與正規化。
- `src/modelFilter.ts`：供應商分類、版本比較、顯示篩選與其設定選單。
- `src/modelPresets.ts`：固定模型組合的設定解析、自動名稱與管理選單。
- `src/modelCards.ts`、`src/modelCardStore.ts`：model card 解析與快取。
- `src/settings.ts`：extension 設定與自訂價格讀取。
- `src/thinking.ts`、`src/thinkingStore.ts`、`src/thinkingTags.ts`：thinking 請求設定、持久化、回應標籤處理。
- `src/errors.ts`、`src/operationErrorContext.cjs`、`src/operationErrorContext.d.cts`：錯誤呈現與操作脈絡。
- `src/signIn.ts`：使用者啟動的 AWS SSO 登入。
- `src/statusBar.ts`：token 用量、thinking effort、登入狀態列。
- `src/pricing.ts`、`src/priceStore.ts`：價格解析、費用估算、價格快取。
- `src/usage.ts`、`src/usageView.ts`、`src/usagePanel.ts`：使用量記錄、彙總、面板。
- `test/`：Vitest 單元測試（含 manifest／task／版本與 CHANGELOG 結構契約、開發 Host CLI 替身）；`test/vscode-stub.ts` 為 VS Code API 替身。
- `README.md`、`README.zh-tw.md`、`README.ja.md`：三語使用說明。
- `CHANGELOG.md`、`CHANGELOG.zh-tw.md`、`CHANGELOG.ja.md`：三語版本紀錄。
- `package.nls*.json`、`l10n/`：manifest 與執行期介面翻譯。
- `LICENSE`、`THIRD-PARTY-NOTICES.md`：專案授權與第三方聲明。
