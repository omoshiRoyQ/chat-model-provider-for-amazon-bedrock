---
description: "Use when changing cost estimation, price tables, model-card price parsing, or long-context usage classification. Covers price source order and the long-context threshold rule."
applyTo: "src/pricing.ts, src/priceStore.ts, src/modelCards.ts, src/modelCardStore.ts, src/usage.ts, src/usageView.ts, src/usagePanel.ts"
---

# 費用估算

- 價格來源依序是：使用者的 `customPricing`、AWS 公開價格檔 `AmazonBedrockFoundationModels/current/<region>/index.json`（不需要 `pricing:*` 權限）、AWS model card 的 Pricing 段落。model card 是使用者同意的第二來源（2026-10-04），理由是 GPT-6 Astra 的 card 價格與價格檔完全相同，而其他 GPT 只在 card 上有價格。兩個來源都查不到的單價不可自行推測，也不可用 OpenAI 官方價格換算。
- card 的表格解析失敗時視為沒有價格，修正 `src/modelCards.ts`；`check-model-cards` 會列出「有價格表但解析失敗」的 card。
- 價格檔的 region 一律用設定值，沒有設定時用 SDK 從 profile 解析到的值，不可寫死 `us-west-2`。
- GPT 的 long-context 價格：單一請求的輸入超過門檻（card 寫 272K）時，整個請求都用 long-context 單價。門檻寫在 CATALOG 的 `longContextThreshold`，每次記錄使用量時就分類，因為累計後就分不出來。判斷用的是總輸入（含快取讀取與寫入），這是使用者的決定（2026-10-04）。理由：card 沒寫快取算不算，寧可多估也不要少估；費用本來就是估算，有人回報與帳單不符再改。
