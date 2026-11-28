# Chat Model Provider for Amazon Bedrock

[EN](README.md) | [JA](README.ja.md)

使用你指定的 AWS named profile（支援 SSO），在 VS Code Chat 使用 Amazon Bedrock 模型。Extension 不使用或儲存 API key，也不會將使用狀況或診斷紀錄傳送給作者。Chat 請求會傳送到 Amazon Bedrock；使用量統計、各模型的 thinking 設定與下載的價格表會儲存在 VS Code 的本機 extension storage。

此 extension 只使用 `bedrock-runtime` endpoint 的 Native ConverseStream API；不使用 `bedrock-mantle` endpoint，也不使用 `bedrock-runtime` 上的 OpenAI 相容 Chat Completions／Responses 或 Anthropic Messages API。

## 功能

- 從 AWS 帳戶載入可用的 Bedrock 模型，依地理區域或 global inference profile 選擇路由。
- 可依供應商篩選符合條件的模型，並查看模型系列，例如 Anthropic（Claude）、OpenAI（GPT、GPT-OSS、GPT-OSS Safeguard）、xAI（Grok）、NVIDIA（Nemotron）。Claude、一般 GPT、Grok 可各自設定最低版本；版本未知的模型會保留，並在套用門檻時標示。
- 支援 Chat Agent 工具呼叫；模型支援圖片輸入時，也可傳送圖片。
- 可依模型設定 thinking effort；不支援的選項可能由 extension 調整，或由 Bedrock 拒絕。
- 可為支援設定 thinking 的模型建立固定 effort 的額外 Chat 項目；原始模型仍保留。組合名稱會依據底層模型的顯示名稱、effort 與固定路由自動產生，例如 `Luna-Medium (Geo)`。
- 狀態列顯示本期輸入／輸出 token 累計；使用量面板依模型列出請求數、token 數（含 prompt cache 的讀取與寫入）與費用估算。每次請求的 Bedrock token 用量另行回報給 VS Code，供 Chat Session Info／context window 資訊使用；這不是本期累計，也不會混入 Copilot credit 統計。
- 支援 prompt cache 的 Claude 模型會使用 Bedrock prompt caching，重複的對話內容可以從快取讀取。
- 可更新價格表、設定自訂價格、設定每月使用量重設日期與 UTC 時間。只有可存取同一份共用本機儲存的 Host 會共用使用量總計（依 AWS profile 分組）、下載的區域價格表與模型卡快取；價格更新或排程重設時間一到，就會自動更新狀態列和已開啟的使用量面板。

## 必要條件

- VS Code 1.106 或更新版本。
- AWS CLI v2，以及已設定的 AWS profile。此 extension 只使用 AWS profile，不接受 API key 或直接輸入 access key。
- AWS 帳戶已開通 Amazon Bedrock，且選擇的模型可在設定的 region／inference scope 使用。

## 開始使用

1. 使用 AWS CLI v2 設定 SSO profile：
   ```powershell
   aws configure sso
   ```
2. 登入該 profile：
   ```powershell
   aws sso login --profile <profile>
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

- **圖片**：每個模型會依下列優先順序，使用第一個有資料的來源：extension 內建的圖片實測結果，其次是 `bedrock:ListFoundationModels` 回報的 `inputModalities`（輸入類型）。兩者都沒有資料時，模型允許附圖；若模型不支援圖片輸入，送出後會顯示錯誤。已知不支援圖片的模型不會收到圖片，extension 改送文字提示。Agent 工具回傳的圖片（例如截圖）也依相同規則處理。
- **模型清單**：只列出 ID 以 `us.`、`global.` 等前綴開頭的模型。只能直接用 model ID 呼叫的模型（例如 `openai.gpt-oss-20b-1:0`）不會出現。
- **Model Visibility 設為顯示所有供應商時**：圖片產生、embedding 等無法對話的模型也會出現在選單中。

預設只選取 Anthropic 與 OpenAI 時，主要差別在圖片這一項。

部分第三方 Marketplace 模型還需要 `aws-marketplace:ViewSubscriptions` 和 `aws-marketplace:Subscribe`，並完成該模型的訂閱。實際 resource ARN 與條件請由 AWS 管理員依所用模型、region 和組織政策設定。

若要檢查模型清單的權限，請代入你的 profile 與 region 執行下列指令。這些指令不會呼叫模型，也不會產生費用。

```powershell
aws bedrock list-inference-profiles --profile <profile> --region <region>
aws bedrock list-foundation-models --profile <profile> --region <region>
```

第一個指令失敗時，extension 無法載入模型清單。只有第二個指令失敗時，仍可對話，差別如上所列。這些指令不會檢查 `bedrock:InvokeModelWithResponseStream`，要確認這項權限，請在 Chat 送出一則訊息。

## 設定選項

### 透過命令選擇區操作（建議）

按 `Ctrl+Shift+P`（macOS：`Cmd+Shift+P`）開啟命令選擇區，輸入 `Bedrock` 尋找以下命令。一般使用不必編輯 JSON，也不必事先查 model ID；下方 JSON 範例供進階設定使用。

**Model Visibility：選擇要顯示的模型**

1. 執行 **Chat Model Provider for Amazon Bedrock: 設定模型顯示篩選**。
2. 選擇 **全部供應商**，或選擇 **選取供應商**，勾選想顯示的供應商並按 Enter。沒有勾選任何供應商時，不會顯示任何模型。
3. 依提示設定 Claude、GPT 或 Grok 的最低版本，例如 `4.6` 或 `6`；留空並按 Enter 代表不限版本。只會詢問所選供應商對應的系列；選擇全部供應商時會詢問三個系列。
4. 核對摘要並選擇 **儲存**，再開啟 Chat 模型選單查看結果。過程中按 Esc 取消不會儲存變更。

**Model Presets：建立固定 thinking effort 的模型組合**

模型組合主要用於自動觸發 Agent 或 sub-agent 的流程：當流程可以選擇模型，卻無法另外指定 thinking effort 時，可將同一個底層模型建立成不同思考等級的組合，讓使用者或負責分派任務的 Agent 依任務難度選擇。例如，一般任務使用 `medium` 組合，較複雜的推理任務使用 `max` 組合，不必在每次執行前手動更改原始模型的 thinking 設定。實際選擇哪個組合由使用者或呼叫端決定；extension 不會自動判斷任務難度或切換組合，且仍須符合模型支援的 effort。

1. 先開啟一次 Chat 模型選單，讓目前可用的模型清單載入。
2. 按 `Ctrl+Shift+P`（macOS：`Cmd+Shift+P`），執行 **Chat Model Provider for Amazon Bedrock: 管理模型組合**，選擇 **新增組合**。
3. 從清單依顯示名稱選取底層模型，並確認該項目的路由（`Geo`、`Global` 或 `In-Region`）；只列出可設定 thinking 的模型，不必手動輸入 model ID。
4. 選擇 thinking effort，核對自動產生的組合名稱，再選擇 **儲存**。model ID、UUID 與固定路由會自動寫入設定；重新開啟 Chat 模型選單即可選取新組合，原始模型仍保留。
5. 日後再次執行 **管理模型組合** 並選取既有組合，可選擇 **變更 thinking effort**（選擇新 effort 後儲存），或 **移除組合**（確認移除）。取消操作不會儲存變更。

模型組合選單只編輯使用者設定；若有工作區覆寫，會提示你開啟工作區設定 JSON，不會直接修改。若新增時沒有可供選擇的模型，請先確認模型清單已載入、顯示篩選允許該模型，且模型支援設定 thinking。

### 設定與 JSON 範例

- **Model Visibility**：使用「設定模型顯示篩選」命令，或在設定 JSON 中編輯 `amazonBedrockProvider.modelVisibility`。預設選取 Anthropic 與 OpenAI，且不限版本。供應商分組會列出模型系列，例如 Anthropic（Claude）、OpenAI（GPT、GPT-OSS、GPT-OSS Safeguard）、xAI（Grok）與 NVIDIA（Nemotron）。`all` 模式也包含未來新增的供應商；`selected` 模式的 `providers` 空陣列代表不選取任何供應商。選單只會讓你設定已選取供應商的最低版本；儲存時會移除未選取供應商先前儲存的門檻。模型仍須符合 Bedrock 與 Chat 既有條件。

  2.0.0 已移除舊設定 `amazonBedrockProvider.modelFilter`。若先前設為 `all`，請將 `amazonBedrockProvider.modelVisibility` 設為 `{"mode":"all","providers":[]}`，保留顯示所有供應商的行為；其他情況預設為 Anthropic 與 OpenAI，且不限版本。

  選填的 `minimumVersions` 可為 Claude、一般 GPT、Grok 設定最低版本門檻，門檻本身也符合條件。設定 GPT 門檻時，GPT-OSS 與 Safeguard 模型也會隱藏。若模型版本格式無法判讀，該模型仍會保留並標示「版本未知」；因此，最低版本不保證清單上的每個模型都達到該門檻。例如：

  ```json
  {
    "amazonBedrockProvider.modelVisibility": {
      "mode": "selected",
      "providers": ["anthropic", "openai", "xai"],
      "minimumVersions": {
        "claude": "4.6",
        "gpt": "6",
        "grok": "4.7"
      }
    }
  }
  ```

- **Model Presets（模型組合）**：使用「管理模型組合」命令，從目前清單選取可設定 thinking 的模型與路由，新增組合、變更 effort、移除組合或開啟設定 JSON。原始模型的設定不會變更。選單與 JSON 共用 `amazonBedrockProvider.modelPresets`。每筆包含 `id`、foundation model 的 `modelId`、固定的 `route`（`Geo`、`Global` 或 `In-Region`）與 `effort`（`default`、`off`、`low`、`medium`、`high`、`xhigh` 或 `max`）。選單會為新組合產生 UUID，並依底層模型名稱、effort 與路由產生 Chat 顯示名稱；名稱不會存入設定，也不能修改。

  ```json
  {
    "amazonBedrockProvider.modelPresets": [
      {
        "id": "f603514d-c89f-4b7e-9c11-9255b4658467",
        "modelId": "openai.gpt-6-luna",
        "route": "Geo",
        "effort": "medium"
      },
      {
        "id": "31e8bb3c-40b6-4b0d-9163-1772b145941e",
        "modelId": "openai.gpt-6-luna",
        "route": "Geo",
        "effort": "max"
      }
    ]
  }
  ```

  未設定此選項，或設為空陣列時，表示沒有組合。工作區設定會完整取代使用者設定陣列；管理命令只編輯使用者設定，若目前有工作區覆寫，會引導你開啟工作區設定 JSON。重複的 `id`，或 `modelId`、`route`、`effort` 全部相同的項目都會被拒絕。組合只有在底層模型目前可透過組合中儲存的路由呼叫，且符合模型顯示篩選時，才會列入清單。切換 inference scope 不會替組合改換路由。底層模型或路由暫時不可用時，組合會隱藏但設定保留；恢復可用後會再次顯示。

  組合固定使用儲存的 effort，不受底層模型的 thinking effort 設定或 **全部重設** 影響。不支援的 effort 仍依既有請求處理方式調整或由 Bedrock 拒絕；建立組合不代表 Bedrock 一定接受該 effort。

- **Inference Scope**：`geo` 會使用地理區 inference profile，只提供 global profile 的模型不會列出。`global` 會優先使用 global profile，請求可能路由至世界各地的 AWS region；模型沒有 global profile 時，改用地理區 profile。
- **Usage Reset Day／Hour**：指定每月重設日（1～31）與 UTC 小時（0～23）。當月沒有該日期時，會在當月最後一天重設。修改排程不會立刻清除使用量，會在新排程的下一個重設時間清除。
- **Custom Pricing**：依 model ID 設定每百萬 token 的美元單價；自訂價格優先於下載的價格表。`cacheRead` 與 `cacheWrite` 是選填的 prompt cache 單價；沒有填寫時，有讀取或寫入 prompt cache 的請求不會估算費用。例如：

  ```json
  {
    "openai.gpt-6-astra": {
      "input": 5,
      "output": 20
    }
  }
  ```

- **Proxy URL**：可設定選填的 `amazonBedrockProvider.proxyUrl`（machine scope），值須為 `http://` 或 `https://` proxy 網址。只有此擴充功能會使用它連線 Amazon Bedrock，以及下載 AWS 公開價格表／模型卡；不會讀取 `HTTP_PROXY` 或 `HTTPS_PROXY` 環境變數，也不支援在網址中內嵌憑證。

## 使用量與費用

Bedrock 回報的輸入／輸出 token 會依 AWS profile、模型與 inference route，累計到 Default Profile 的 VS Code 擴充功能 `globalStorage` 目錄中的共用使用量檔案；因此只有可存取同一份共用本機儲存的 Host 會累計到同一份總計，資料仍依 AWS profile 分組。每次請求的 Bedrock 輸入／輸出數量另行回報給 VS Code，供 Chat Session Info／context window 資訊使用；這與本期累計分開，也不會影響 Copilot credit 總計。排程重設時間到達時，擴充功能會自動更新狀態列和已開啟的使用量面板。可存取同一本機路徑的 Host 會使用同一份 JSON 使用量檔案；Node 內建的 SQLite 只用來協調寫入鎖，不會儲存使用量。若沒有可共用的本機路徑、鎖逾時或儲存空間無法使用，該筆使用量會略過，不會改存到 VS Code Profile，也不會排隊日後補記，因此估算可能偏低；略過該筆時不會刪除或搬移既有使用量；排程或手動重設仍照常運作。這不影響 Chat 回應、Session Info token 數或 AWS 帳單。既有的一次性 VS Code `globalState` 舊使用量遷移仍會保留；新略過的記錄不會搬移。費用是估算值，不等同 AWS 帳單；實際費用以 AWS 帳單為準。按下 **更新價格** 會下載 AWS 公開價格表以及 AWS 模型卡 上的價格表，並分別寫入同一 Default Profile `globalStorage` 目錄下的共用 JSON 檔（依 region 分組的 `shared-prices.json` 與 `shared-model-cards.json`），各自使用獨立的 SQLite 寫入鎖；任一 VS Code Profile 更新後，共用同一本機路徑的其他視窗也會即時更新顯示。若沒有可共用的本機路徑、鎖逾時或寫入失敗，價格與模型卡下載會直接回報錯誤且不會回退寫入各 Profile 的 `globalState`；既有舊版 `globalState` 價格表與模型卡快取會執行一次性遷移，且不會覆蓋共用區已有的資料。單價依序取自自訂價格、公開價格表、模型卡，所以公開價格表沒有的 GPT 模型也能估算費用；價格取自 模型卡 時，費用欄會標示 **模型卡**。三者都沒有價格的模型會顯示 **無價格資料**。

固定組合的請求會依底層模型與路由記錄使用量及估算費用，因此會和同路由的原始模型累計在一起。effort 可能影響 Bedrock 回報的 token 數，但不會新增另一套價格或改變費用估算方式。

部分 GPT 模型在單一請求的輸入超過 272K token 時，整個請求都改用長 context 價格（依各自的 模型卡）；Claude Haiku 5.5 超過 100K token 時也一樣（依 Anthropic 價格頁，AWS 的 模型卡 沒有標示門檻）。Extension 會在記錄每個請求時，判斷輸入 token 數是否超過門檻（快取讀取與寫入也算在輸入內），超過的請求用長 context 單價計算。這個版本之前記錄的使用量一律用一般單價計算。自訂價格沒有長 context 分級，模型有長 context 請求且只有自訂價格時，費用欄會顯示 **沒有長 context 價格**。

對於 [AWS 文件](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)列為支援 prompt caching 的 Claude 模型，extension 會在工具定義、system prompt 與最新一則訊息的結尾加上 cache point。GPT 等其他模型也可能自行回報快取讀取或寫入。使用量面板的 **輸入 token** 分成 **輸入**（未快取）、**快取讀取**、**快取寫入**三欄，相加就是總輸入，狀態列顯示的是這個總數。快取讀取與寫入分別計價。快取單價來自公開價格表或 模型卡（GPT 的快取寫入用 30 分鐘的單價）；如果價格是用舊版下載的，請再按一次 **更新價格**。模型有快取 token 但沒有快取單價時，費用欄會顯示 **沒有快取價格**，該模型的費用不計入總計。

狀態列會顯示本期輸入／輸出 token；點選 token 數可開啟使用量面板。面板也可更新價格、開啟自訂價格設定和重設使用量。

## 安全與隱私

### 資料使用與網路連線

此 extension 不會將使用狀況、診斷紀錄或分析資料傳送給作者。使用量統計儲存在 VS Code 本機，診斷紀錄可在本機查看以協助排查問題。Chat 內容則依下節說明傳送到 Amazon Bedrock。Extension 會發出以下網路請求：

1. 透過你的 AWS profile 連線至所選 region 的 Amazon Bedrock（載入模型清單、串流對話）。擴充功能使用 SDK 預設的 Bedrock HTTPS 端點，忽略 AWS 設定檔與環境變數中的 Bedrock 端點覆寫。
2. 你按下「更新價格」時，向 AWS 公開價格檔網址送出 HTTPS GET；請求不含帳號資訊或 AWS 憑證。
3. 向 AWS 公開文件（docs.aws.amazon.com）的模型卡頁面送出 HTTPS GET，讀取 context window、最大輸出 token 數與價格：模型清單出現內建資料沒有的模型時在背景讀取（快取 7 天），按下「更新價格」時則重新讀取所有模型卡。請求不含帳號資訊或 AWS 憑證。

公開下載只會跟隨同一 HTTPS 來源的重新導向。大小上限在解壓縮前後皆適用：價格檔為 64 MiB，每份模型卡或索引為 8 MiB。

設定 `amazonBedrockProvider.proxyUrl` 後，只有此擴充功能會在上述請求使用該 `http://` 或 `https://` proxy，且不會讀取 `HTTP_PROXY` 或 `HTTPS_PROXY` 環境變數。Proxy 網址不支援內嵌憑證。HTTPS proxy 與目的端的 TLS 憑證都必須受信任；即使 Node.js 環境停用憑證驗證，擴充功能仍不會略過 TLS 驗證。

你按下登入按鈕時，extension 會在本機啟動 AWS CLI 的 `aws sso login`，AWS CLI 會打開瀏覽器讓你完成登入（例如選擇帳號、核准存取）；extension 不會在背景自動登入。

VS Code 本身可能傳送的使用狀況與診斷資料，依 VS Code 的 `telemetry.telemetryLevel` 設定決定，不受此 extension 控制。

### AWS 憑證

- Bedrock 請求一律以你指定的 AWS named profile 進行 SigV4 簽署，不接受 API key（包括 `AWS_BEARER_TOKEN_BEDROCK`），也不能直接輸入 access key。
- 若所選 profile 使用 `credential_process`，AWS SDK 可能在載入模型清單時執行該 profile 設定的本機指令，不必等你選取 **登入**。請選擇設定與憑證指令都可信任的 profile。
- AWS 憑證由 AWS SDK 在每次請求時透過 profile 取得。Extension 不會把 access key、secret key、session token 或 SSO token 存進 VS Code 設定、`globalState` 或紀錄。
- SSO 登入由 AWS CLI 處理。AWS SDK 會讀取 `~/.aws/config` 與 `~/.aws/credentials` 來找到 profile；SSO token 快要過期時，也可能會和 AWS CLI 一樣更新 `~/.aws/sso/cache/` 中的 token。Extension 不會修改其他 AWS 檔案。

### 你的對話內容

- Chat 對話、工具結果和附件只會傳送到你自己 AWS 帳戶中的 Amazon Bedrock，由你的 IAM 權限、AWS 帳單與 AWS 條款管理。
- 依 AWS 文件，模型供應商無法存取 Amazon Bedrock 的客戶 prompt 與回應。詳見 [Amazon Bedrock Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)。
- Inference scope 設為 `global` 時，請求可能路由至世界各地的 AWS region；如果資料必須留在特定地區處理，請使用 `geo`。
- 支援 prompt caching 的 Claude 模型，Bedrock 會把快取的 prompt 開頭部分保留 5 分鐘（預設 TTL），讓之後的請求重複使用。

### 本機儲存

- Default Profile 的擴充功能 `globalStorage` 目錄中，會以共用檔案儲存使用量統計（profile 名稱、model ID、token 數與請求數）。只有可存取同一份共用本機儲存的 Host 會累計到此檔案，總計仍依 AWS profile 分組；排程重設會自動更新狀態列和已開啟的使用量面板。
- VS Code `globalState` 儲存各模型的 thinking 設定、下載的價格表，以及從 AWS 模型卡讀取的 token 上限與價格。這些資料不會同步到其他裝置。thinking 設定可用 **設定 thinking effort** 指令重設為 Default；按下 **更新價格** 時會取代下載的價格表。
- Extension 不會將 Chat 對話內容寫入本機儲存或紀錄。

### 紀錄

- **顯示紀錄** 只記錄 profile 名稱、region、model ID、訊息數量、tool 名稱與錯誤碼等診斷資訊，不記錄對話內容。錯誤訊息中的 AWS principal ARN 與 email 會先遮蔽。
- 擴充功能會先遮蔽網址參數、Start URL 中的組織名稱、電子郵件地址與一次性裝置授權碼，再記錄 AWS CLI 登入輸出。分享紀錄前仍請檢查是否有個人識別資料。登入時瀏覽器沒有開啟的話，請在終端機執行 `aws sso login --profile <profile>`。

### 開放原始碼

原始碼以 MIT 授權公開在 [GitHub](https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock)，你可以自行檢查或建置。發現安全問題時，請透過 GitHub 的 Security 頁面私下回報，不要在公開 issue 貼出 AWS 憑證或紀錄。

## 疑難排解

- **尚未設定 AWS region**：在 VS Code 設定 `amazonBedrockProvider.region`，或在 AWS profile 中設定 region。
- **缺少模型清單權限**：請管理員授予 `bedrock:ListInferenceProfiles`。
- **模型呼叫遭拒**：檢查 profile 是否有 `bedrock:InvokeModelWithResponseStream`，並確認模型在所選 region／inference scope 可用；Marketplace 模型也可能需要訂閱權限。
- **SSO 登入失效**：按 Bedrock 登入按鈕，或執行 `aws sso login --profile <profile>`，再重新送出失敗的 Chat 請求。
- **未使用設定的網路路徑**：確認 `amazonBedrockProvider.proxyUrl` 是不含內嵌憑證的 `http://` 或 `https://` 網址。此擴充功能不會讀取 `HTTP_PROXY` 或 `HTTPS_PROXY`。
- **完整診斷**：使用命令面板的 **顯示紀錄**；分享前請遮蔽個人資料與驗證資訊。

## 產生 VSIX

執行 `pnpm run package:verified`，依序執行全部單元測試、封裝，並列出封裝內容。封裝時會自動執行 `vscode:prepublish`，完成型別檢查、授權與語系檢查及正式建置；每項前置流程只跑一次，失敗就停止後續步驟。VSIX 產生在 `.tmp/chat-model-provider-for-amazon-bedrock-<version>.vsix`。

`pnpm run verify` 是不產生 VSIX 的完整檢查；`pnpm run package` 是僅執行封裝的指令，會自動執行 prepublish，但不跑單元測試。安全審查、發布稽核與安裝後的 VSIX 驗收仍須另外完成。這些指令不安裝、不發布，也不呼叫 Bedrock 模型；執行失敗時，不要把先前留下的 VSIX 當成本次產生的 VSIX。

## 授權

本專案採 MIT 授權，詳見 [LICENSE](LICENSE)。隨附相依套件的授權與版權聲明見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

本專案只由作者一人維護，且不接受外部 pull request。歡迎回報 issue，也歡迎依 MIT 授權 fork 後建立自己的專案，但仍須註明本專案為來源，並保留所需的著作權與授權聲明。

Amazon Bedrock 與 AWS 為 Amazon.com, Inc. 或其關係企業的商標。本專案由第三方獨立開發，與 Amazon.com, Inc. 或 AWS 無隸屬關係，也未獲其背書或贊助。