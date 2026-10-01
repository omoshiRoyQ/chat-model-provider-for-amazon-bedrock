# Changelog

[EN](#en) | [TW](#tw) | [JP](#jp)

## EN

### 1.1.0 (2026-10-01)

- Chat instructions from VS Code are now sent as the Converse system prompt instead of being mixed into your message. Models that do not accept system prompts, such as Mistral 7B Instruct, automatically receive the instructions as message text instead.
- Amazon Nova responses no longer show the `<thinking>` text or the `<response>` and `<answer>` tags that Nova adds when tools are available.
- Models missing from the built-in list now use the context window and maximum output tokens from their public AWS model card. The card is read in the background; thinking parameters are still omitted for these models.
- Models whose AWS model card shows that `bedrock-runtime` does not support Converse, such as Nova 2 Sonic, are no longer listed.
- The conservative context window for models without any published limit is now 128K instead of 32K.
- Added Claude Sonnet 5.5 to the built-in list, so attached images are no longer dropped. Its thinking cannot be turned off, so **Off** uses low effort.
- Added gpt-oss 120b, gpt-oss 20b, gpt-oss-safeguard 120b, and gpt-oss-safeguard 20b to the built-in list with thinking effort support.
- Updated GPT-5.x and GPT-6 limits to match their current AWS model cards (1,050,000-token context window, 128,000 max output tokens).
- `bedrock:ListFoundationModels` is no longer required, though still recommended. Without it, models are loaded from inference profiles only, and image input is enabled for every model; models that do not support images return an error when you attach one.
- Models without foundation model information now allow image input instead of disabling it.
- The missing model list permission message now names `bedrock:ListInferenceProfiles`.

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

### 1.1.0（2026-10-01）

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

### 1.1.0（2026-10-01）

- VS Code から送られる Chat の指示を、メッセージに混ぜず Converse のシステムプロンプトとして送信するようになりました。システムプロンプトを受け付けないモデル（Mistral 7B Instruct など）には、指示を自動的にメッセージ本文として送信します。
- Amazon Nova が tool 利用時に追加する `<thinking>` のテキストと `<response>`、`<answer>` タグを応答に表示しなくなりました。
- 内蔵リストにないモデルは、AWS 公開モデルカードのコンテキストウィンドウと最大出力 token 数を使用するようになりました。モデルカードはバックグラウンドで読み取ります。これらのモデルには引き続き thinking パラメーターを送信しません。
- AWS モデルカードで `bedrock-runtime` が Converse に対応していないとされているモデル（Nova 2 Sonic など）は表示しなくなりました。
- 上限がまったくわからないモデルの保守的なコンテキストウィンドウを 32K から 128K に変更しました。
- 内蔵リストに Claude Sonnet 5.5 を追加し、添付画像が削除されないようにしました。thinking はオフにできないため、**Off** を選ぶと low effort を使用します。
- 内蔵リストに gpt-oss 120b、gpt-oss 20b、gpt-oss-safeguard 120b、gpt-oss-safeguard 20b を追加し、thinking effort を設定できるようにしました。
- GPT-5.x と GPT-6 の上限を現在の AWS モデルカードに合わせました（コンテキストウィンドウ 1,050,000 token、最大出力 128,000 token）。
- `bedrock:ListFoundationModels` は必須ではなくなりました（付与を推奨します）。この権限がない場合は推論プロファイルのみからモデルを読み込み、すべてのモデルで画像入力を有効にします。画像に対応していないモデルに画像を添付するとエラーが返されます。
- 基盤モデル情報を取得できないモデルでは、画像入力を無効にせず有効にするようになりました。
- モデル一覧の権限不足を示すエラーメッセージで `bedrock:ListInferenceProfiles` を示すようになりました。

### 1.0.0（2026-09-29）

初回リリース。

- AWS 名前付きプロファイル（AWS IAM Identity Center／SSO 対応）を通じて VS Code Chat で Amazon Bedrock モデルを利用できます。使用するのは `bedrock-runtime` の Native ConverseStream API のみです。
- AWS アカウントから利用可能なモデルを読み込み、地域または global 推論プロファイルのルーティングと、Claude／GPT のみまたは全モデルの表示を選択できます。
- 対応モデルでの Agent の tool 呼び出しと画像入力。
- モデルごとの thinking effort 設定。
- ステータスバーに今期の入力／出力 token 数を表示し、使用量パネルではモデルごとのリクエスト数、token 数、費用の推定値を確認できます。価格表の更新、独自価格、毎月のリセット日程も設定できます。
- SSO サインインの期限切れ時にサインインボタンを表示します。`aws sso login` はボタンを選択したときのみ実行します。
- telemetry を送信せず、分析データを作者に送信することもありません。
