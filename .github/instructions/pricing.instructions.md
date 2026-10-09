---
description: "Use when changing cost estimation, price tables, model-card price parsing, or long-context usage classification. Covers price source order and the long-context threshold rule."
applyTo: "src/pricing.ts, src/priceStore.ts, src/modelCards.ts, src/modelCardStore.ts, src/usage.ts, src/usageView.ts, src/usagePanel.ts"
---

# 費用估算

- 價格來源依序是：使用者的 `customPricing`、AWS 公開價格檔 `AmazonBedrockFoundationModels/current/<region>/index.json`（不需要 `pricing:*` 權限）、AWS model card 的 Pricing 段落。model card 是使用者同意的第二來源（2026-10-04），理由是 GPT-6 Astra 的 card 價格與價格檔完全相同，而其他 GPT 只在 card 上有價格。兩個來源都查不到的單價不可自行推測，也不可用 OpenAI 官方價格換算。
- card 的表格解析失敗時視為沒有價格，修正 `src/modelCards.ts`；`check-model-cards` 會列出「有價格表但解析失敗」的 card。
- 價格檔的 region 一律用設定值，沒有設定時用 SDK 從 profile 解析到的值，不可寫死 `us-west-2`。
- long-context 價格：單一請求的輸入超過門檻時，整個請求都用 long-context 單價。門檻寫在 CATALOG 的 `longContextThreshold`，每次記錄使用量時就分類，因為累計後就分不出來。判斷用的是總輸入（含快取讀取與寫入），這是使用者的決定（2026-10-04）。理由：card 沒寫快取算不算，寧可多估也不要少估；費用本來就是估算，有人回報與帳單不符再改。
- 門檻來源：GPT 取自 model card 的 Pricing 段落（272K）。Claude 目前只有 Haiku 5.5 有這一層，門檻 100K 取自 Anthropic 官方價格頁（`platform.claude.com/docs/en/about-claude/pricing` 的「prompts over 100,000 tokens」），因為 AWS 的 card 與價格頁都沒寫門檻；這是使用者的決定（2026-10-09）。AWS 公開價格檔有 `_long_ctx` 單價可佐證有這一層，但不含門檻。反例：看到價格檔有 `_long_ctx` 就沿用 GPT 的 272K。
- 依 Geo、Global 或 In-Region 路由選價，查 `src/pricing.ts` 的 `lookupPrice`。
- cache read 與 cache write 必須各自套用對應單價。例：input 4、cacheRead 0、cacheWrite 35,463、output 931；每百萬單價依序為 input $4、read $0.2、write $5、output $20，估算為 $0.195951，畫面顯示 $0.1960。
- 區域價格表由使用者按 Update Prices 後下載並按 region 儲存，沒有內建價格表。cost 是估算值，畫面顯示到小數點後四位，實際費用以 AWS 帳單為準。
