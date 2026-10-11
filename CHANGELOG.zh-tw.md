# 變更紀錄

[EN](CHANGELOG.md) | [JP](CHANGELOG.ja.md)

## 1.4.1（2026-10-11）

- AWS SSO token 仍過期時，狀態列的「登入」按鈕不會再消失。先前 VS Code 重新讀取快取的模型清單就會隱藏按鈕；現在只有對 AWS 的請求成功或完成登入後才會隱藏。

## 1.4.0（2026-10-10）

- 即使 thinking effort 為預設，只要內建清單或 AWS model card 有公布最大輸出 token 數，請求現在都會送出該上限。先前 Claude Haiku 5.5 等模型的長回應會在 4,096 token 被截斷。沒有公布上限的模型仍不送出上限。
- 回應因達到最大輸出 token 數而停止時，紀錄會寫入一則警告，包含模型 ID 與上限值。
- 下載價格表時，等待超過 60 秒會逾時，不再無限期等待。
- 實測不支援工具的模型不再列出。
- 圖片輸入支援優先採用實測結果，其次才依 AWS 公布的輸入模態。
- 聊天紀錄中已知的 `stateful_marker` 項目遭略過時，不再記錄警告。

## 1.3.0（2026-10-09）

- 內建清單加入 Claude Haiku 5.5。輸入（含快取讀取與寫入）超過 100K token 的請求，依 Anthropic 價格頁的說明整個請求改用長 context 單價計算。只有這個版本之後記錄的使用量會分類。

## 1.2.1（2026-10-06）

- 使用量面板的估算費用現在會標示價格來源：自訂價格、AWS 價格表或 model card。

## 1.2.0（2026-10-04）

- [AWS 文件](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)列為支援 prompt caching 的 Claude 模型改用 Bedrock prompt caching：在工具定義、system prompt 與最新一則訊息的結尾加上 cache point，使用預設的 5 分鐘 TTL。
- 使用量統計加入 prompt cache 的讀取與寫入。使用量面板的 **輸入 token** 分成 **輸入**（未快取）、**快取讀取**、**快取寫入**三欄，相加就是總輸入；狀態列的輸入數改為含快取 token 的總輸入。
- 費用估算依 AWS 價格表中的快取單價，分別計算快取讀取與寫入的費用；請再按一次 **更新價格**下載快取單價。自訂價格可選填 `cacheRead` 與 `cacheWrite`。模型有快取 token 但沒有快取單價時，費用欄顯示 **沒有快取價格**，不估算費用。
- **更新價格** 也會讀取 AWS model card 上的價格表，AWS 公開價格表沒有、但 model card 列有價格的模型（例如多數 GPT）也能估算費用。來自 model card 的價格會標示 **model card**，只在自訂價格與公開價格表都沒有該模型時使用。
- GPT 長 context 計價：輸入（含快取讀取與寫入）超過 272K token 的請求，依 model card 的說明整個請求改用長 context 單價計算。只有這個版本之後記錄的使用量會分類。
- 改用 AWS 公開價格表中 GPT-6 Astra 的 30 分鐘快取寫入單價。
- 內建清單加入 GPT-6.1 Sol。它的 reasoning effort 不能設為 `none`，選擇 **Off** 時會改用 low effort。

## 1.1.1（2026-10-02）

- 紀錄中的 AWS CLI 登入輸出會隱藏網址參數、Start URL 中的組織名稱與電子郵件地址。登入時瀏覽器沒有開啟的話，請在終端機執行 `aws sso login --profile <profile>`。

## 1.1.0（2026-10-01）

- VS Code 送出的 Chat 指示改用 Converse 的 system prompt 傳送，不再混進你的訊息。不接受 system prompt 的模型（例如 Mistral 7B Instruct）會自動改成把指示放在訊息文字中。
- Amazon Nova 在有工具可用時加入的 `<thinking>` 文字，以及 `<response>`、`<answer>` 標籤，不再顯示在回應中。
- 內建清單沒有的模型，改用 AWS 公開 model card 上的 context window 與最大輸出 token 數。Model card 會在背景讀取；這些模型仍不送 thinking 參數。
- AWS model card 表示 `bedrock-runtime` 不支援 Converse 的模型（例如 Nova 2 Sonic）不再列出。
- 完全查不到上限的模型，保守的 context window 從 32K 改為 128K。
- 內建清單加入 Claude Sonnet 5.5，附加的圖片不會再被移除。它的 thinking 不能關閉，選擇 **Off** 時會改用 low effort。
- 內建清單加入 gpt-oss 120b、gpt-oss 20b、gpt-oss-safeguard 120b 與 gpt-oss-safeguard 20b，可設定 thinking effort。
- GPT-5.x 與 GPT-6 的上限改成與目前的 AWS model card 一致（context window 1,050,000 token、最大輸出 128,000 token）。
- `bedrock:ListFoundationModels` 不再是必要權限，但仍建議授予。沒有這個權限時，只從 inference profile 載入模型，並對所有模型開放圖片輸入；對不支援圖片的模型附圖時會回傳錯誤。
- 查不到 foundation model 資訊的模型改為開放圖片輸入，不再停用。
- 缺少模型清單權限的錯誤訊息改為指出 `bedrock:ListInferenceProfiles`。

## 1.0.0（2026-09-29）

首次發布。

- 透過 AWS named profile（支援 AWS IAM Identity Center／SSO）在 VS Code Chat 使用 Amazon Bedrock 模型，只使用 `bedrock-runtime` 的 Native ConverseStream API。
- 從 AWS 帳戶載入可用模型，可選擇地理區域或 global inference profile 路由，並可篩選只顯示 Claude 與 GPT 或顯示所有模型。
- 支援模型提供的 Agent 工具呼叫與圖片輸入。
- 可依模型設定 thinking effort。
- 狀態列顯示本期的輸入／輸出 token；使用量面板依模型列出請求數、token 數與費用估算，並可更新價格表、設定自訂價格與每月重設排程。
- SSO 登入失效時提供登入按鈕；只有使用者按下時才執行 `aws sso login`。
- 不傳送遙測，也不會將分析資料傳送給作者。
