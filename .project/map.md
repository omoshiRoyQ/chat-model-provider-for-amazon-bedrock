# chat-model-provider-for-amazon-bedrock 地圖

最後核對：2026-10-06，核對對象：AGENTS.md、package.json、定價與用量原始碼

## 範圍
VS Code LanguageModelChatProvider，透過 Amazon Bedrock Runtime Native ConverseStream 提供模型。TypeScript、pnpm、esbuild。
建置：pnpm run compile。測試：pnpm test，測試位於 test/。

## 物件對照
- Extension 啟用與註冊：src/extension.ts
- Chat 請求與 Native ConverseStream：src/provider.ts、src/native.ts、src/convert.ts
- 模型目錄與清單：src/models.ts、src/modelList.ts、src/modelCards.ts、src/modelCardStore.ts
- 用量記錄與長 context 分類：src/usage.ts（UsageStore、addUsage、isLongContext）
- 費用公式、AWS 價格檔解析、價格查找：src/pricing.ts（estimateCost、estimateModelCost、parseOffer、lookupPrice）
- AWS model card 價格解析：src/modelCards.ts（parseCardPricing）
- 自訂價格解析：src/settings.ts（readCustomPricing）
- 區域價格表快取與下載：src/priceStore.ts（PriceStore）
- 用量檢視資料與畫面：src/usageView.ts（buildUsageView）、src/usagePanel.ts（UsagePanel、renderCost）
- 費用與用量測試：test/pricing.test.ts、test/usage.test.ts、test/usagePanel.test.ts

## 資料
- globalState 的 usage:<profile>：src/usage.ts 寫入並讀取各模型的週期用量。
- globalState 的 prices:<region>：src/priceStore.ts 儲存使用者下載的區域價格表。

## 已確認的決定
- 價格查找順序為 customPricing、AWS 區域價格表、model card；依 Geo、Global 或 In-Region 路由選價。查 src/pricing.ts 的 lookupPrice。
- Cache read 與 cache write 必須各自套用對應單價。例：input 4、cacheRead 0、cacheWrite 35,463、output 931；每百萬單價依序為 input $4、read $0.2、write $5、output $20，估算為 $0.195951，畫面顯示 $0.1960。

## 刻意保留的行為與陷阱
- 區域價格表由使用者按 Update Prices 後下載並按 region 儲存；沒有內建價格表。查 src/priceStore.ts、src/usagePanel.ts。
- cost 是估算值，畫面顯示到小數點後四位；實際費用以 AWS 帳單為準。

## 驗證
- pnpm run compile：先檢查 TypeScript，再以 esbuild 建置。
- pnpm test：執行 Vitest。
- VSIX 安裝後的 Extension Host、Chat 模型清單及實際 AWS 請求需由使用者在 VS Code 中確認；詳見 AGENTS.md。