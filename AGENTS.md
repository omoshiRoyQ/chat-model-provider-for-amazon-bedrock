# chat-model-provider-for-amazon-bedrock

這個 VS Code extension 實作 `LanguageModelChatProvider`，把 Amazon Bedrock 的模型接進 VS Code Chat 的模型選單。模型請求只使用 `bedrock-runtime` endpoint 的 AWS SDK Native ConverseStream API；不使用 `bedrock-mantle` endpoint，也不使用 `bedrock-runtime` 上的 OpenAI 相容 Chat Completions／Responses 或 Anthropic Messages API。技術堆疊為 TypeScript，套件管理用 pnpm，使用 esbuild 建置。

## 環境與權限

- 認證只使用使用者指定的 AWS named profile，透過 AWS SDK 的 `fromIni({ profile })` 取得憑證，支援 SSO。不支援 API key、直接提供 access key 或 SDK default credential chain；除非使用者明確提出需求，否則不得擴充。理由：使用者選擇安全性優先於泛用性；目前只維護已驗證的 profile + SSO 流程，避免增加憑證儲存與選擇路徑。
- 測試用的 profile 名稱與 region 由使用者提供，不可寫死在程式碼或測試中。
- `profile`、`region`、`inferenceScope` 設定刻意不宣告 `scope`，受信任專案的 `.vscode/settings.json` 可以覆寫。這不算資安問題，資安審查不必列出。理由：使用者的決定（2026-10-04）；專案只能指定名稱，認證仍只能用使用者 `~/.aws/config` 裡既有的 profile。

## 必須先經過使用者同意的動作

- 發布到 VS Code Marketplace（`vsce publish`）。目前只發布到 Marketplace，不發布到 Open VSX。
- 修改 `~/.aws/config`、`~/.aws/credentials` 或 `~/.aws/sso/cache/`。需要登入時請使用者自己執行 `aws sso login`。

## 建置、測試與驗證

- 套件管理一律用 pnpm，不可執行 `npm install` 或 `yarn`，也不可產生 `package-lock.json`、`yarn.lock`。理由：使用者的偏好；多個 lockfile 並存會讓相依版本不一致。
- 建置：`pnpm run compile`（先 `tsc --noEmit` 檢查型別，再用 esbuild 輸出 `dist/extension.js`）
- 測試：`pnpm test`（Vitest，測試放在 `test/*.test.ts`）。單元測試不在 Extension Host 裡執行，`vscode` 模組由 `vitest.config.mts` 以 alias 換成 `test/vscode-stub.ts`；`src` 用到新的 VS Code 類別時，要同步補進替身。`pnpm run compile` 也會以 `tsconfig.test.json` 檢查測試程式的型別。
- 測試的預期值要來自 AWS 文件、實測的 AWS 回應或使用者決定，並在測試檔註明來源；不可拿程式自己算出來的結果當預期值。
- 證據層級：編譯通過不代表 extension 能啟用；在 Extension Development Host（F5）能用，也不代表封裝後的 VSIX 能用，因為 esbuild 合併輸出時可能遺漏相依套件。兩者都要分別驗證。
- 模型能否出現在 Chat 選單、Agent 模式能否呼叫 tool，都只能由使用者在 VS Code 內實際操作確認。回報時要說清楚這一步還沒驗證。
- 冷煙測試（安裝 VSIX 後）：`Show Logs` 有 `Extension activated`；Chat 模型選單出現 Amazon Bedrock 模型；對便宜的模型送一則短訊息有回應，狀態列 token 數增加；Agent 模式呼叫一次工具；使用量面板可以開啟。
- 用 AWS CLI 驗證 Bedrock 權限時，優先使用不計費的控制面 API（`list-inference-profiles`、`list-foundation-models`）；必須測 runtime 時，用 `maxTokens=1` 並挑便宜的模型。

## 專用規則與流程

只和特定檔案有關的規則放在 `.github/instructions/`（改到對應檔案時自動載入）：`pricing`（費用估算）、`dependencies`（相依套件與授權）。有固定步驟的流程放在 `.github/skills/`：`update-catalog`（更新 CATALOG）、`release`（版本號、CHANGELOG、封裝 VSIX）。

## 發布說明格式

使用者的決定（2026-10-09），`release-notes` skill 依此產出 GitHub release 草稿：

- 標題與 tag 相同（例：`1.3.0`）；本文用英文。
- `## What's Changed`：`CHANGELOG.md` 該版段落的條列原文，數量相同。
- 注意事項段落：條列提到網路存取、遙測、資料儲存、權限、憑證或登入流程、升級後要手動執行的步驟、費用計算時才加，每段一到三句並連到 README 對應章節；都沒提到就省略。
- `## Other languages`：`[TW](…/blob/<tag>/CHANGELOG.zh-tw.md) | [JP](…/blob/<tag>/CHANGELOG.ja.md)`。
- 所有連結固定在 tag（`https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock/blob/<tag>/...`）；不加 `Full Changelog` 比較連結。
- 附件：從 tag 所在 commit 建置的 `chat-model-provider-for-amazon-bedrock-<version>.vsix`。

## 程式碼規範

- 不可複製三個參考 extension（`arifum.bedrock-vscode-chat`、`easytocloud.bedrock-mantle-vscode-chat`、`abhimanyus1997.bedrock-bridge-copilot`）的程式碼，只能參考做法。理由：使用者的決定。
- Credential 一律交給 AWS SDK 的 provider（例如 `fromIni({ profile })`）處理，每次請求都透過 provider 取得。不可把 `accessKeyId`、`secretAccessKey`、`sessionToken` 存進自己的變數或快取重複使用。理由：參考 extension 在 SSO 過期後不會重新整理，就是這個原因。
- SSO token 過期（`ExpiredTokenException`、`TokenRefreshRequired`、`CredentialsProviderError` 等）時，要顯示明確的錯誤訊息，提示使用者執行 `aws sso login --profile <name>`，並提供「登入」按鈕。不可只回一般錯誤，也不可無聲重試。按鈕只能由使用者按下才執行 `aws sso login`，不可在背景自動執行，也不可自動重送失敗的 Chat 請求。理由：自動開瀏覽器會嚇到使用者，而 VS Code 會頻繁在背景查詢模型清單。
- 回報給 VS Code 的 `maxInputTokens`、`maxOutputTokens` 必須有來源（AWS 文件或 API 回傳值），並在程式碼註解標出來源。沒有來源的模型用保守值，並寫進 log。不可從模型名稱推測（反例：看到 `claude` 就回報 200K）。理由：參考 extension 回報錯誤的 context window。
- 某個模型呼叫失敗時，錯誤訊息要包含 model ID、呼叫路徑（目前固定為 Native）與 AWS 回傳的原始錯誤碼。理由：參考 extension 有部分模型呼叫失敗卻無從判斷原因。
- 只有與帳號無關的失敗才能在 `PROBED_CAPABILITIES` 用 `unsupported` 排除模型（已下線用 `retired`，不支援 Converse 用 `noConverse`，實測不支援工具用 `tools: false`）。帳號權限或帳號設定造成的失敗一律不排除，因為別的帳號可能可以用。反例：Pegasus 1.5 因 `AccessDeniedException`（Marketplace 訂閱或帳號不開放）不可排除；Fable 的 data retention mode（需帳號設為 `aws_review`）不可排除；Sonnet 4 的「Legacy 且 30 天未使用」不可排除。理由：排除是全域的，會替所有使用者隱藏模型。
- 使用者看得到的字串（README、CHANGELOG、`package.nls*.json`、`l10n`）要提供 EN、TW、JP 三種版本，EN 為預設。檔案對應：EN 是 `package.nls.json`、`README.md`、`CHANGELOG.md`（l10n 不另外建檔）、TW 是 `*.zh-tw.json`、`*.zh-tw.md`、JP 是 `*.ja.json`、`*.ja.md`。TW 指臺灣華語正體中文。README 等處標示語言時也寫 EN、TW、JP。理由：extension 會發布到 Marketplace；語言代號是使用者的決定。
- 程式碼註解使用英文，方便國際開發者閱讀。反例：`// 取得憑證`。
- Commit message 遵循 Conventional Commits：類型前綴用英文（`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`build`、`ci`），冒號後的說明也用英文。正例：`feat: add Converse streaming response`；反例：`新增 Converse 串流回應`（缺少類型前綴）、`功能: add streaming`（前綴不是標準類型）。理由：業界慣例，可用工具自動產生 CHANGELOG。

## 已知陷阱

- 不要為了「讓受限模式可用」而宣告 `capabilities.untrustedWorkspaces`：VS Code Chat 在 Restricted Mode 會自己封鎖所有模型（模型選單顯示「Models unavailable while in Restricted mode」），宣告 `limited` 也無法改變（2026-10-09 實測）。未宣告時 extension 在受限模式停用，這是預期行為，資安審查不必列為發現。
- `bedrock-runtime` Native 路徑已實測可用 SSO profile：控制面 `list-inference-profiles` 與 runtime `ConverseStream` 都成功（2026-09-25，`us-west-2`）。
- 在這台電腦上按 F5 時，Extension Development Host 視窗會出現 `command '...' not found`。這是假線索：真正的原因是 js-debug 連 `::1:<port>` 被拒（`ECONNREFUSED`），Extension Host 在 60 秒後逾時，所以沒有任何 extension 在執行。不要往指令註冊或 `package.json` 的方向追。確認方式：主視窗 `exthost.log` 有 `ECONNREFUSED ::1`，開發視窗 `renderer.log` 有 `Extension host did not start`。暫時改用 task「Open Extension Development Host」（`Ctrl+Shift+B`）開啟開發視窗，它會先編譯再執行 `code --new-window --extensionDevelopmentPath=<repo>`，這個方式不能設中斷點。換到個人網路後結果相同，所以和外部網路無關，不要往 VPN 或 proxy 的方向追。本機實測：`localhost` 會先解析成 `::1`，而只在 `127.0.0.1` 監聽的偵錯埠連 `::1` 會被拒。（2026-09-25 發生三次）

## 規則維護

- 同一條規則只寫在一個地方，其他地方用名稱引用，不複製內容。
- 每條規則都要能判斷有沒有違反，並附上理由；能寫反例就寫反例。
- 同一類錯誤出現第二次才寫成規則；能用自動檢查擋下的，優先補檢查。
- 新增一條規則時，檢查有沒有可以刪除或合併的舊規則。
- 規則中的工具名稱代表所需能力，以目前工具實際提供的為準。
