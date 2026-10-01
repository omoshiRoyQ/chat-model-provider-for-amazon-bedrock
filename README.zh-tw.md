# Chat Model Provider for Amazon Bedrock

[EN](README.md) | [JP](README.ja.md)

使用你指定的 AWS named profile（支援 SSO），在 VS Code Chat 使用 Amazon Bedrock 模型。Extension 不使用或儲存 API key，也不傳送遙測。Chat 請求會傳送到 Amazon Bedrock；使用量統計、各模型的 thinking 設定與下載的價格表會儲存在 VS Code 的本機 extension storage。

此 extension 只使用 `bedrock-runtime` endpoint 的 Native ConverseStream API；不使用 `bedrock-mantle` endpoint，也不使用 `bedrock-runtime` 上的 OpenAI 相容 Chat Completions／Responses 或 Anthropic Messages API。

## 功能

- 從 AWS 帳戶載入可用的 Bedrock 模型，依地理區域或 global inference profile 選擇路由。
- 使用 Claude、GPT 等支援的模型進行 Chat；可篩選只顯示 Claude 與 GPT，或顯示所有符合條件的模型。
- 支援 Chat Agent 工具呼叫和模型支援的圖片輸入。
- 可依模型設定 thinking effort；不支援的選項可能由 extension 調整，或由 Bedrock 拒絕。
- 狀態列顯示本期的輸入／輸出 token，使用量面板依模型列出請求數、token 數與費用估算。
- 可更新價格表、設定自訂價格、設定每月使用量重設日期與 UTC 時間。

## 系統需求

- VS Code 1.106 或更新版本。
- AWS CLI v2，以及已設定的 AWS profile。此 extension 只使用 AWS profile，不接受 API key 或直接輸入 access key。
- AWS 帳戶已開通 Amazon Bedrock，且所選模型可在設定的 region／inference scope 使用。

## 開始使用

1. 使用 AWS CLI v2 設定 SSO profile：
   ```powershell
   aws configure sso
   ```
2. 登入該 profile：
   ```powershell
   aws sso login --profile bedrock
   ```
3. 在 VS Code 設定 `amazonBedrockProvider.profile`，填入 profile 名稱，例如 `bedrock`。若 profile 沒有 region，請設定 `amazonBedrockProvider.region`。
4. 開啟 Chat 模型選單，選取 Amazon Bedrock 模型並開始對話。

## AWS 權限

| 權限 | 用途 | 是否必要 |
| --- | --- | --- |
| `bedrock:ListInferenceProfiles` | 取得可呼叫的模型清單 | 必要 |
| `bedrock:InvokeModelWithResponseStream` | 與模型串流對話 | 必要 |
| `bedrock:ListFoundationModels` | 取得模型能力，例如是否支援圖片 | 建議 |

沒有 `bedrock:ListFoundationModels` 時仍可正常對話，差別如下：

- **圖片**：extension 無法得知模型是否支援圖片，所以每個模型都允許附圖。模型不支援時，送出後會顯示錯誤。Agent 工具回傳的圖片（例如截圖）也一樣。
- **模型清單**：只列出 ID 以 `us.`、`global.` 等前綴開頭的模型。只能直接用 model ID 呼叫的模型（例如 `openai.gpt-oss-20b-1:0`）不會出現。
- **Model Filter 設為列出所有模型時**：影像生成、embedding 等無法對話的模型也會出現在選單中。

預設只顯示 Claude 與 GPT 時，主要差別在圖片這一項。

部分第三方 Marketplace 模型還需要 `aws-marketplace:ViewSubscriptions` 和 `aws-marketplace:Subscribe`，並完成該模型的訂閱。實際 resource ARN 與條件請由 AWS 管理員依所用模型、region 和組織政策設定。

若要檢查模型清單的權限，請代入你的 profile 與 region 執行下列指令。這些指令不會呼叫模型，也不會產生費用。

```powershell
aws bedrock list-inference-profiles --profile <profile> --region <region>
aws bedrock list-foundation-models --profile <profile> --region <region>
```

第一個指令失敗時，extension 無法載入模型清單。只有第二個指令失敗時，仍可對話，差別如上所列。這些指令不會檢查 `bedrock:InvokeModelWithResponseStream`，要確認這項權限，請在 Chat 送出一則訊息。

## 設定選項

- **Model Filter**：只列出 Claude 與 GPT，或列出所有符合條件的模型。
- **Inference Scope**：`geo` 會使用地理區 inference profile，只提供 global profile 的模型不會列出。`global` 會優先使用 global profile，請求可能路由至世界各地的 AWS region；模型沒有 global profile 時，改用地理區 profile。
- **Usage Reset Day／Hour**：指定每月重設日（1～31）與 UTC 小時（0～23）。當月沒有該日期時，會在當月最後一天重設。修改排程不會立刻清除使用量，會在新排程的下一個重設時間清除。
- **Custom Pricing**：依 model ID 設定每百萬 token 的美元單價；自訂價格優先於下載的價格表。例如：

  ```json
  {
    "openai.gpt-6-astra": {
      "input": 5,
      "output": 20
    }
  }
  ```

## 使用量與費用

Bedrock 回報的輸入／輸出 token 會依 AWS profile、模型與 inference route 累計。費用是估算值，不等同 AWS 帳單；實際費用以 AWS 帳單為準。GPT 等不在 AWS 公開價格表中的模型需設定自訂價格才會估算費用。

狀態列會顯示本期輸入／輸出 token；點選 token 數可開啟使用量面板。面板也可更新價格、開啟自訂價格設定和重設使用量。

## 安全與隱私

### 遙測與網路連線

此 extension 不實作或傳送遙測，也不會將分析資料傳送給作者。Chat 內容會依下節說明傳送到 Amazon Bedrock。Extension 會發出以下網路請求：

1. 透過你的 AWS profile 連線至所選 region 的 Amazon Bedrock（載入模型清單、串流對話）。
2. 你按下「更新價格」時，向 AWS 公開價格檔網址送出 HTTPS GET；請求不含帳號資訊或 AWS 憑證。
3. 模型清單出現內建資料沒有的模型時，向 AWS 公開文件（docs.aws.amazon.com）的 model card 頁面送出 HTTPS GET，讀取 context window 與最大輸出 token 數。查過的模型不會重複查詢，快取超過 7 天才重新讀取；請求不含帳號資訊或 AWS 憑證。

你按下登入按鈕時，extension 會在本機啟動 AWS CLI 的 `aws sso login`，AWS CLI 會打開瀏覽器讓你完成登入（例如選擇帳號、核准存取）；extension 不會在背景自動登入。

VS Code 本身的遙測依 VS Code 的 `telemetry.telemetryLevel` 設定，不受此 extension 控制。

### AWS 憑證

- 只使用你指定的 AWS named profile，不接受 API key，也不能直接輸入 access key。
- AWS 憑證由 AWS SDK 在每次請求時透過 profile 取得。Extension 不會把 access key、secret key、session token 或 SSO token 存進 VS Code 設定、`globalState` 或紀錄。
- SSO 登入由 AWS CLI 處理。AWS SDK 會讀取 `~/.aws/config` 與 `~/.aws/credentials` 來找到 profile；SSO token 快要過期時，也可能會和 AWS CLI 一樣更新 `~/.aws/sso/cache/` 中的 token。Extension 不會修改其他 AWS 檔案。

### 你的對話內容

- Chat 對話、工具結果和附件只會傳送到你自己 AWS 帳戶中的 Amazon Bedrock，由你的 IAM 權限、AWS 帳單與 AWS 條款管理。
- 依 AWS 文件，模型供應商無法存取 Amazon Bedrock 的客戶 prompt 與回應。詳見 [Amazon Bedrock Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)。
- Inference scope 設為 `global` 時，請求可能路由至世界各地的 AWS region；如果資料必須留在特定地區處理，請使用 `geo`。

### 本機儲存

- 只在 VS Code `globalState` 儲存使用量統計（profile 名稱、model ID、token 數與請求數）、每個模型的 thinking 設定、下載的價格表，以及從 AWS model card 讀取的 token 上限。這些資料不會同步到其他裝置。使用量統計可從使用量面板重設，thinking 設定可用「設定 thinking effort」指令重設為 Default；下載的價格表會在你按下「更新價格」時被新的價格表取代。
- Extension 不會將 Chat 對話內容寫入本機儲存或紀錄。

### 紀錄

- 「顯示紀錄」只記錄 profile 名稱、region、model ID、訊息數量、tool 名稱與錯誤碼等診斷資訊，不記錄對話內容。錯誤訊息中的 AWS principal ARN 與 email 會先遮蔽。
- 紀錄會包含 AWS CLI 登入輸出，其中網址參數、Start URL 中的組織名稱與電子郵件地址會換成 `[redacted]`。分享紀錄前仍請檢查是否有個人識別資料。登入時瀏覽器沒有開啟的話，請在終端機執行 `aws sso login --profile <profile>`。

### 開放原始碼

原始碼以 MIT 授權公開在 [GitHub](https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock)，你可以自行檢查或建置。發現安全問題時，請透過 GitHub 的 Security 頁面私下回報，不要在公開 issue 貼出 AWS 憑證或紀錄。

## 疑難排解

- **尚未設定 AWS region**：在 VS Code 設定 `amazonBedrockProvider.region`，或在 AWS profile 中設定 region。
- **缺少模型清單權限**：請管理員授予 `bedrock:ListInferenceProfiles`。
- **模型呼叫遭拒**：檢查 profile 是否有 `bedrock:InvokeModelWithResponseStream`，並確認模型在所選 region／inference scope 可用；Marketplace 模型也可能需要訂閱權限。
- **SSO 登入失效**：按 Bedrock 登入按鈕，或執行 `aws sso login --profile <profile>`，再重新送出失敗的 Chat 請求。
- **完整診斷**：使用命令面板的 **顯示紀錄**；分享前請遮蔽個人資料與驗證資訊。

## 授權

本專案採 MIT 授權，詳見 [LICENSE](LICENSE)。隨附相依套件的授權與版權聲明見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

本專案只由作者一人維護。歡迎 fork 後做成你自己的專案，只要註明出處是本專案，並依 MIT 授權保留版權與授權聲明即可。

Amazon Bedrock 與 AWS 為 Amazon.com, Inc. 或其關係企業的商標。本專案由第三方獨立開發，與 Amazon.com, Inc. 或 AWS 無隸屬關係，也未獲其背書或贊助。