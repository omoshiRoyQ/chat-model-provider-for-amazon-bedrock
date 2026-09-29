# Changelog

[EN](#en) | [TW](#tw) | [JP](#jp)

## EN

### 1.0.0 (2026-09-29)

First release.

- Use Amazon Bedrock models in VS Code Chat through an AWS named profile (AWS IAM Identity Center / SSO supported), using only the `bedrock-runtime` Native ConverseStream API.
- Load available models from your AWS account, with geo or global inference profile routing and a Claude/GPT-only or all-models filter.
- Agent tool calling and image input for models that support them.
- Per-model thinking effort.
- The status bar shows this period's input and output tokens; the usage panel shows per-model request counts, tokens, and cost estimates, with price table updates, custom pricing, and a monthly reset schedule.
- Sign-in button for expired SSO sessions; `aws sso login` runs only when you select it.
- No telemetry, and no analytics data is sent to the author.

## TW

### 1.0.0（2026-09-29）

首次發布。

- 透過 AWS named profile（支援 AWS IAM Identity Center／SSO）在 VS Code Chat 使用 Amazon Bedrock 模型，只使用 `bedrock-runtime` 的 Native ConverseStream API。
- 從 AWS 帳戶載入可用模型，可選擇地理區域或 global inference profile 路由，並可篩選只顯示 Claude 與 GPT 或顯示所有模型。
- 支援模型提供的 Agent 工具呼叫與圖片輸入。
- 可依模型設定 thinking effort。
- 狀態列顯示本期的輸入／輸出 token；使用量面板依模型列出請求數、token 數與費用估算，並可更新價格表、設定自訂價格與每月重設排程。
- SSO 登入失效時提供登入按鈕；只有使用者按下時才執行 `aws sso login`。
- 不傳送遙測，也不會將分析資料傳送給作者。

## JP

### 1.0.0（2026-09-29）

初回リリース。

- AWS 名前付きプロファイル（AWS IAM Identity Center／SSO 対応）を通じて VS Code Chat で Amazon Bedrock モデルを利用できます。使用するのは `bedrock-runtime` の Native ConverseStream API のみです。
- AWS アカウントから利用可能なモデルを読み込み、地域または global 推論プロファイルのルーティングと、Claude／GPT のみまたは全モデルの表示を選択できます。
- 対応モデルでの Agent の tool 呼び出しと画像入力。
- モデルごとの thinking effort 設定。
- ステータスバーに今期の入力／出力 token 数を表示し、使用量パネルではモデルごとのリクエスト数、token 数、費用の推定値を確認できます。価格表の更新、独自価格、毎月のリセット日程も設定できます。
- SSO サインインの期限切れ時にサインインボタンを表示します。`aws sso login` はボタンを選択したときのみ実行します。
- telemetry を送信せず、分析データを作者に送信することもありません。
