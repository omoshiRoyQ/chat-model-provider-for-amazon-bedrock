# chat-model-provider-for-amazon-bedrock

這個 VS Code extension 實作 `LanguageModelChatProvider`，把 Amazon Bedrock 的模型接進 VS Code Chat 的模型選單。模型請求只使用 `bedrock-runtime` endpoint 的 AWS SDK Native ConverseStream API；不使用 `bedrock-mantle` endpoint，也不使用 `bedrock-runtime` 上的 OpenAI 相容 Chat Completions／Responses 或 Anthropic Messages API。技術堆疊為 TypeScript，套件管理用 pnpm，使用 esbuild 建置。

## 環境與權限

- 認證只使用使用者指定的 AWS named profile，透過 AWS SDK 的 `fromIni({ profile })` 取得憑證，支援 SSO。不支援 API key、直接提供 access key 或 SDK default credential chain；除非使用者明確提出需求，否則不得擴充。理由：使用者選擇安全性優先於泛用性；目前只維護已驗證的 profile + SSO 流程，避免增加憑證儲存與選擇路徑。
- 測試用的 profile 名稱與 region 由使用者提供，不可寫死在程式碼或測試中。

## 必須先經過使用者同意的動作

- `git push`。
- 發布到 VS Code Marketplace（`vsce publish`）。目前只發布到 Marketplace，不發布到 Open VSX。
- 修改 `~/.aws/config`、`~/.aws/credentials` 或 `~/.aws/sso/cache/`。需要登入時請使用者自己執行 `aws sso login`。

## 建置、測試與驗證

- 套件管理一律用 pnpm，不可執行 `npm install` 或 `yarn`，也不可產生 `package-lock.json`、`yarn.lock`。理由：使用者的偏好；多個 lockfile 並存會讓相依版本不一致。
- 建置：`pnpm run compile`（先 `tsc --noEmit` 檢查型別，再用 esbuild 輸出 `dist/extension.js`）
- 測試：`pnpm test`（Vitest，測試放在 `test/*.test.ts`）。單元測試不在 Extension Host 裡執行，`vscode` 模組由 `vitest.config.mts` 以 alias 換成 `test/vscode-stub.ts`；`src` 用到新的 VS Code 類別時，要同步補進替身。`pnpm run compile` 也會以 `tsconfig.test.json` 檢查測試程式的型別。
- 測試的預期值要來自 AWS 文件、實測的 AWS 回應或使用者決定，並在測試檔註明來源；不可拿程式自己算出來的結果當預期值。
- pnpm 預設禁止相依套件執行 build script，esbuild 已在 `pnpm-workspace.yaml` 的 `allowBuilds` 允許。之後新增的套件如果需要 build script，`pnpm install` 會以 `ERR_PNPM_IGNORED_BUILDS` 失敗，要先問使用者，再用 `pnpm approve-builds <pkg>` 加入。不可用 `--all` 一次全部允許。理由：build script 能執行任意程式，屬於供應鏈風險。
- 封裝 VSIX：`pnpm run vsix`。一定要帶 `--no-dependencies`：esbuild 會將 extension 程式碼和相依套件合併輸出為單一檔案 `dist/extension.js`，而 vsce 預設用 npm 檢查 `node_modules`，和 pnpm 的目錄結構不相容。`.vscodeignore` 只放行 `dist/extension.js`、`package*.json`、`l10n/`、`icon.png`、README、LICENSE、THIRD-PARTY-NOTICES、CHANGELOG；封裝後要看 vsce 列出的檔案清單，確認沒有 `src`、`test`、`node_modules`。（2026-09-26 實測）
- `@vscode/vsce-sign` 在 `pnpm-workspace.yaml` 的 `allowBuilds` 設為 `false`：它是 vsce 的簽章工具，安裝腳本會下載執行檔，但 `vsce package` 不需要它（2026-09-26 實測）。發布時如果需要簽章，先問使用者再改。
- 證據層級：編譯通過不代表 extension 能啟用；在 Extension Development Host（F5）能用，也不代表封裝後的 VSIX 能用，因為 esbuild 合併輸出時可能遺漏相依套件。兩者都要分別驗證。
- 模型能否出現在 Chat 選單、Agent 模式能否呼叫 tool，都只能由使用者在 VS Code 內實際操作確認。回報時要說清楚這一步還沒驗證。
- 用 AWS CLI 驗證 Bedrock 權限時，優先使用不計費的控制面 API（`list-inference-profiles`、`list-foundation-models`）；必須測 runtime 時，用 `maxTokens=1` 並挑便宜的模型。
- 新增、升級或移除 production dependency 時，要更新 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 的套件清單、授權全文與上游版權聲明。
- esbuild 會打包 runtime imports，不會依 `dependencies` 或 `devDependencies` 分類；目前 devDependencies 沒有被 extension runtime 匯入。若 devDependency 改為 runtime import，必須移入 `dependencies` 並納入 notices。
- `pnpm run check-licenses` 只確認 `pnpm licenses list --prod --json` 回報的授權識別字都在允許清單，且每個 production 套件名稱字串都出現在 THIRD-PARTY-NOTICES.md。它不會驗證套件是否列在正確授權章節、授權全文或上游版權聲明；這些仍須人工對照上游授權檔。`pnpm run package`／`pnpm run vsix` 都會先執行檢查。授權識別字不在允許清單（MIT、Apache-2.0、0BSD）時，檢查會失敗並列出套件名稱；必須先人工判斷授權相容性與散布條件，不可自行擴充允許清單。

## 程式碼規範

- 不可複製三個參考 extension（`arifum.bedrock-vscode-chat`、`easytocloud.bedrock-mantle-vscode-chat`、`abhimanyus1997.bedrock-bridge-copilot`）的程式碼，只能參考做法。理由：使用者的決定。
- Credential 一律交給 AWS SDK 的 provider（例如 `fromIni({ profile })`）處理，每次請求都透過 provider 取得。不可把 `accessKeyId`、`secretAccessKey`、`sessionToken` 存進自己的變數或快取重複使用。理由：參考 extension 在 SSO 過期後不會重新整理，就是這個原因。
- SSO token 過期（`ExpiredTokenException`、`TokenRefreshRequired`、`CredentialsProviderError` 等）時，要顯示明確的錯誤訊息，提示使用者執行 `aws sso login --profile <name>`，並提供「登入」按鈕。不可只回一般錯誤，也不可無聲重試。按鈕只能由使用者按下才執行 `aws sso login`，不可在背景自動執行，也不可自動重送失敗的 Chat 請求。理由：自動開瀏覽器會嚇到使用者，而 VS Code 會頻繁在背景查詢模型清單。
- 回報給 VS Code 的 `maxInputTokens`、`maxOutputTokens` 必須有來源（AWS 文件或 API 回傳值），並在程式碼註解標出來源。沒有來源的模型用保守值，並寫進 log。不可從模型名稱推測（反例：看到 `claude` 就回報 200K）。理由：參考 extension 回報錯誤的 context window。
- 某個模型呼叫失敗時，錯誤訊息要包含 model ID、呼叫路徑（目前固定為 Native）與 AWS 回傳的原始錯誤碼。理由：參考 extension 有部分模型呼叫失敗卻無從判斷原因。
- 使用者看得到的字串（README、`package.nls*.json`、`l10n`）要提供 EN、TW、JP 三種版本，EN 為預設。檔案對應：EN 是 `package.nls.json`（l10n 不另外建檔）、TW 是 `*.zh-tw.json`、JP 是 `*.ja.json`。TW 指臺灣華語正體中文。README 等處標示語言時也寫 EN、TW、JP。理由：extension 會發布到 Marketplace；語言代號是使用者的決定。
- 程式碼註解使用英文，方便國際開發者閱讀。反例：`// 取得憑證`。
- Commit message 遵循 Conventional Commits：類型前綴用英文（`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`build`、`ci`），冒號後的說明也用英文。正例：`feat: add Converse streaming response`；反例：`新增 Converse 串流回應`（缺少類型前綴）、`功能: add streaming`（前綴不是標準類型）。理由：業界慣例，可用工具自動產生 CHANGELOG。

## 已知陷阱

- `bedrock-runtime` Native 路徑已實測可用 SSO profile：控制面 `list-inference-profiles` 與 runtime `ConverseStream` 都成功（2026-09-25，`us-west-2`）。
- 在這台電腦上按 F5 時，Extension Development Host 視窗會出現 `command '...' not found`。這是假線索：真正的原因是 js-debug 連 `::1:<port>` 被拒（`ECONNREFUSED`），Extension Host 在 60 秒後逾時，所以沒有任何 extension 在執行。不要往指令註冊或 `package.json` 的方向追。確認方式：主視窗 `exthost.log` 有 `ECONNREFUSED ::1`，開發視窗 `renderer.log` 有 `Extension host did not start`。暫時改用 task「Open Extension Development Host」（`Ctrl+Shift+B`）開啟開發視窗，它會先編譯再執行 `code --new-window --extensionDevelopmentPath=<repo>`，這個方式不能設中斷點。換到個人網路後結果相同，所以和外部網路無關，不要往 VPN 或 proxy 的方向追。本機實測：`localhost` 會先解析成 `::1`，而只在 `127.0.0.1` 監聽的偵錯埠連 `::1` 會被拒。（2026-09-25 發生三次）

- 費用估算的價格來源是 AWS 公開價格檔 `AmazonBedrockFoundationModels/current/<region>/index.json`（不需要 `pricing:*` 權限）。Claude 在裡面，GPT-5.6、GPT-6 不在任何 Bedrock 公開 offer 裡（2026-09-26 查過 `AmazonBedrockFoundationModels`、`AmazonBedrock`、`AmazonBedrockService`），只能由使用者填 `amazonBedrockProvider.customPricing`。不要再去其他 offer 找 GPT 價格，也不可自行推測 GPT 單價。價格檔的 region 一律用設定值，沒有設定時用 SDK 從 profile 解析到的值，不可寫死 `us-west-2`。

## 規則維護

- 同一條規則只寫在一個地方，其他地方用名稱引用，不複製內容。
- 每條規則都要能判斷有沒有違反，並附上理由；能寫反例就寫反例。
- 同一類錯誤出現第二次才寫成規則；能用自動檢查擋下的，優先補檢查。
- 新增一條規則時，檢查有沒有可以刪除或合併的舊規則。
- 規則中的工具名稱代表所需能力，以目前工具實際提供的為準。
