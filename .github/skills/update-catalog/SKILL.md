---
name: update-catalog
description: 'Update the built-in model CATALOG in src/models.ts from AWS model cards. Use when adding new Claude or GPT models, checking context window, max output, thinking format, promptCache, or longContextThreshold drift, or running check-model-cards.'
---

# 更新 CATALOG

`pnpm run check-model-cards --profile <使用者提供> --region <使用者提供>` 會讀取 AWS 公開 model card 與 CATALOG 比對，對可以加入的 Claude／GPT 模型送小的 ConverseStream 請求實測 thinking 格式（會產生少量費用），再印出可以直接貼進 CATALOG 的行，不修改檔案。不帶 `--profile`、`--region` 時只讀文件、不計費，thinking 會印成 `'TODO'`。理由：thinking 格式從文件看不出來（Opus 5.5 不能關閉 thinking 是實測才發現的）。

## 步驟

1. 依輸出修改 CATALOG：貼上「可以加入」與「改成」的行（連同 `// Verified` 註解），刪除「可以刪除」的項目，並更新 CATALOG 開頭的查閱日期。`promptCache` 由腳本依 AWS [prompt-caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) 頁面的支援表決定：只有可以在 Converse `messages` 放 cache point 的模型才標記，只支援 Responses API 的 GPT 不標。「promptCache 與 prompt-caching 頁面不一致」列出的項目也要依「改成」修正。
2. 標示「無法實測」的項目（沒有權限、模型已 EOL 等）先問使用者，不可比照同系列的模型自行填 thinking，理由同「不從模型名稱推測」。`'TODO'` 會讓型別檢查失敗，不要貼進 CATALOG。
3. 執行 `pnpm test`、`pnpm run compile`，並在 `CHANGELOG.md`、`CHANGELOG.zh-tw.md`、`CHANGELOG.ja.md` 三個檔案都記錄。
4. 腳本的判斷或解析出錯時，修正 [scripts/check-model-cards.mts](../../../scripts/check-model-cards.mts) 或 `src/modelCards.ts`，不要手動繞過。
