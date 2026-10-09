# chat-model-provider-for-amazon-bedrock 地圖

最後核對：2026-10-09，核對對象：原始碼（src、scripts、test）、package.json、.github、.gitignore、.vscodeignore

## 範圍
VS Code LanguageModelChatProvider，透過 Amazon Bedrock Runtime Native ConverseStream 提供模型。TypeScript、pnpm、esbuild。
進入點：src/extension.ts（activate），建置輸出 dist/extension.js。
建置：pnpm run compile。測試：pnpm test（test/*.test.ts，vscode 以 test/vscode-stub.ts 替身）。
封裝：pnpm run vsix（vsix:ls 只列清單）。模型 card 比對：pnpm run check-model-cards [--profile <名稱> --region <region>]。
規則：AGENTS.md（全域）、.github/instructions/（pricing、dependencies）。流程：.github/skills/（release、update-catalog）。

## 不要讀
- dist/、node_modules/：建置輸出與相依套件。

## 物件對照
- Extension 啟用與註冊：src/extension.ts
- Chat 請求與 Native ConverseStream：src/provider.ts、src/native.ts、src/convert.ts
- 模型目錄與清單：src/models.ts（CATALOG、resolveModels）、src/modelList.ts
- AWS model card 解析與快取：src/modelCards.ts（parseModelCard、parseCardPricing、converseCacheModelIds）、src/modelCardStore.ts（ModelCardStore）
- thinking 參數：src/thinking.ts（buildThinkingRequest）、src/thinkingStore.ts（ThinkingStore）、src/thinkingTags.ts（ThinkingTagFilter）
- 錯誤與 SSO 登入：src/errors.ts、src/signIn.ts（SsoSignIn）
- 狀態列：src/statusBar.ts（TokenStatusBar、ThinkingStatusBar、SignInStatusBar）
- 設定與自訂價格：src/settings.ts（readCustomPricing）
- 用量記錄與長 context 分類：src/usage.ts（UsageStore、addUsage、isLongContext）
- 費用公式、AWS 價格檔解析、價格查找：src/pricing.ts（estimateCost、estimateModelCost、parseOffer、lookupPrice）
- 區域價格表快取與下載：src/priceStore.ts（PriceStore）
- 用量檢視資料與畫面：src/usageView.ts（buildUsageView）、src/usagePanel.ts（UsagePanel、renderCost）
- 開發檢查腳本：scripts/check-model-cards.mts（CATALOG 對 model card）、scripts/check-third-party-notices.mjs（授權）
- 多語系：package.nls.json／.zh-tw.json／.ja.json、l10n/bundle.l10n.*.json、README*.md、CHANGELOG*.md

## 任務入口
- 新增或更新模型：先讀 .github/skills/update-catalog/SKILL.md，再改 src/models.ts 的 CATALOG（longContextThreshold 的來源見 .github/instructions/pricing.instructions.md）。
- 改費用估算：先讀 .github/instructions/pricing.instructions.md，再讀 src/pricing.ts 的 lookupPrice、estimateModelCost。
- 發版：先讀 .github/skills/release/SKILL.md。

## 資料
- globalState 的 usage:<profile>：src/usage.ts 寫入並讀取各模型的週期用量。
- globalState 的 prices:<region>：src/priceStore.ts 儲存使用者下載的區域價格表。

## 待整理
- 2026-10-09 原「已確認的決定」「刻意保留的行為與陷阱」兩段（價格查找順序、cache 單價例子、價格表由使用者下載、cost 為估算值）已原文搬到 .github/instructions/pricing.instructions.md（project-map skill：單一專案的規則不放 map.md）
