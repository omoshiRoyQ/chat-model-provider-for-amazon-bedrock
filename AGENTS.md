# chat-model-provider-for-amazon-bedrock

VS Code extension，實作 `LanguageModelChatProvider`，把 Amazon Bedrock 模型接進 VS Code Chat 模型選單。只使用 `bedrock-runtime` endpoint 的 AWS SDK Native ConverseStream API；不使用 `bedrock-mantle` endpoint，也不使用 `bedrock-runtime` 上的 OpenAI 相容 Chat Completions／Responses 或 Anthropic Messages API。TypeScript、pnpm、esbuild。本文件可獨立接手，不依賴個人電腦上的規則檔。

## Environment and Permissions

- 認證只使用使用者指定的 AWS named profile，透過 AWS SDK 的 `fromIni({ profile })` 取得憑證，支援 SSO。不支援 API key、直接提供 access key 或 SDK default credential chain；除非使用者明確提出需求，否則不得擴充。理由：使用者選擇安全性優先於泛用性，避免增加憑證儲存與選擇路徑。
- 測試用的 profile 名稱與 region 由使用者提供，不可寫死在程式碼或測試中。
- `profile`、`region`、`inferenceScope` 設定刻意不宣告 `scope`，受信任專案的 `.vscode/settings.json` 可以覆寫。這不算資安問題，資安審查不必列出。理由：使用者的決定（2026-10-04）；專案只能指定名稱，認證仍只能用使用者 `~/.aws/config` 裡既有的 profile。`modelVisibility`、`modelPresets`、`customPricing`、`usageResetDay`、`usageResetHour` 同樣可被受信任專案覆寫，屬同一項決定（2026-10-25），資安審查不必列出；影響是專案可顯示較貴的模型，或壓低費用估算。

## Do Not Read

- `dist/`：建置產物；除非任務明確需要檢查建置或封裝內容，否則不讀取。
- `node_modules/`：安裝的相依套件；除非任務明確需要授權或封裝內容檢查，否則不讀取。

## Actions Requiring User Approval

- 發布到 VS Code Marketplace（`vsce publish`）。目前只發布到 Marketplace，不發布到 Open VSX。
- 修改 `~/.aws/config`、`~/.aws/credentials` 或 `~/.aws/sso/cache/`。需要登入時請使用者自己執行 `aws sso login`。

## Build, Test and Verification

- 套件管理只用 pnpm，不新增 npm／yarn lock。devDependencies 用精確版本；安裝建置指令維持 `pnpm-workspace.yaml` 逐項 `allowBuilds` 核准，不擴大範圍。
- 授權：devDependencies 沒有被 runtime 匯入；執行期相依套件依實際散布內容列入 `THIRD-PARTY-NOTICES.md`。允許清單為 MIT、ISC、BSD-2-Clause、BSD-3-Clause、Apache-2.0、0BSD，其他授權先確認。檢查腳本不能取代上游著作權與授權全文核對。
- 建置：`pnpm run compile`（`tsc --noEmit` 後以 esbuild 輸出 `dist/extension.js`）。測試：`pnpm test`（Vitest，`test/*.test.ts`）；`typecheck` 另以 `tsconfig.test.json` 檢查測試與 Bedrock 開發腳本，保留 `Node16` 模組解析與既有嚴格旗標。
- 開發 Host：`dev` 為 `pnpm run compile && node scripts/dev-host.mjs`，先編譯一次；腳本依自身位置解析專案絕對路徑，同時傳給 `--extensionDevelopmentPath` 與工作區參數，開啟非偵錯 Host（需 `code` CLI）。`.vscode/tasks.json` 的 `Open Extension Development Host` 排第一、執行 `pnpm run dev`、cwd 為 `${workspaceFolder}`、是唯一 `group.isDefault` build task、`presentation.reveal` 為 `always`、不得加 compile `dependsOn`。不建議 F5，但保留既有 `.vscode/launch.json`。
- 證據層級：單元測試、編譯、Host、安裝後 VSIX 互不替代；發布驗收須操作實際 VSIX。
- VSIX：`.vscodeignore` 以白名單控制內容。`pnpm run package:verified`（全部單元測試 → package → package:ls）任一步失敗即停止；`package` 為 `vsce package --no-dependencies`，由 `vscode:prepublish` 各執行一次 typecheck、check 與 production build，不要先接 `verify` 重複檢查。`verify` 是不封裝的完整驗證，`package:ls` 只列內容；皆不取代安全／發布審查或安裝後驗收。
- 測試預期值來自 AWS 文件、實測的 AWS 回應或使用者決定，並在測試檔註明來源；不可用程式自己算出的結果當預期值。
- `verify` 不可包含 `check-model-cards`、`probe-models`（後者會送計費請求，前者帶 `--profile` 時也會）。探測結果寫入 `.tmp/probe-models-results.txt`，每次覆寫、不進 Git（使用者 2026-10-21 決定）。
- 模型能否出現在 Chat 選單、Agent 模式能否呼叫 tool，只能由使用者在 VS Code 內操作確認；回報時說明尚未驗證。
- 冷煙測試（安裝 VSIX 後）：`Show Logs` 有 `Extension activated`；Chat 模型選單出現 Amazon Bedrock 模型；對便宜模型送一則短訊息有回應且狀態列 token 數增加；Agent 模式呼叫一次工具；使用量面板可開啟。
- AWS CLI 驗證權限優先用不計費的控制面 API（`list-inference-profiles`、`list-foundation-models`）；必須測 runtime 時用 `maxTokens=1` 並挑便宜模型。

## Documentation and Localization

- 使用者文件及介面維持 EN／TW／JP，EN 為預設，TW 使用臺灣華語；README 與 CHANGELOG 各有 `.md`、`.zh-tw.md`、`.ja.md`。修改任一語言時同步另外兩語並維持章節／條目對應；無法同步則明列未完成，不改寫歷史條目。
- Manifest 字串使用 `package.nls.json`、`package.nls.zh-tw.json`、`package.nls.ja.json`；執行期字串以英文原文作為 `vscode.l10n.t` key，翻譯放在 `l10n/bundle.l10n.zh-tw.json` 與 `l10n/bundle.l10n.ja.json`，不建立英文 bundle。修改 UI 或字串時同步翻譯並執行 `pnpm run check:l10n`；動態訊息仍須人工核對。
- thinking effort 的 `Default` 在 EN／TW／JP 均保留英文，選單與重設說明一致；這是語系例外，不改內部 `default` 值、儲存格式或模型請求。反例：TW 翻成「預設」、JP 翻成「既定」。

## Project-specific Rules

費用估算規則在 `.github/instructions/pricing.instructions.md`；Bedrock 專屬流程在 `.github/skills/update-catalog/`。

## Release Approval

- 封裝前先確認使用者對 `/security-review` 與 `/release-audit` 的選擇（使用者執行、代理執行或略過）；回答前不封裝，略過不代表稽核通過。
- Marketplace 發布、版本更新、三語 CHANGELOG 更新與 VSIX 安裝驗收依使用者明確要求執行；Marketplace 發布與 Git 寫入由使用者執行。不封裝用 `verify`，需 VSIX 用 `package:verified`，兩者不重複；核對 VSIX 不含 `src`、`test`、`node_modules`，失敗時不得把舊產物當成新成品。

## Release Notes Format

- CHANGELOG 每項變更用一至兩句完整句子描述使用者可見行為，不加 Added／Fixed 等分類；三語檔案結構、條目數與順序相符。新版沿用前版樣式並置頂，不改寫歷史。
- GitHub release 本文用英文，條目取自該版 CHANGELOG；只有變更涉及資料／網路、權限／登入、升級手動步驟或費用時，才加注意事項。發布說明草稿不代表已發布。
- `## Other languages`：`[TW](…/blob/<tag>/CHANGELOG.zh-tw.md) | [JP](…/blob/<tag>/CHANGELOG.ja.md)`，連結固定在本次 tag、不連 `main`；語言代號為 EN、TW、JP。
- 連結前綴：`https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock/blob/<tag>/`。附件：對應該版建置的 `chat-model-provider-for-amazon-bedrock-<version>.vsix`。

## Code Conventions

- `modelVisibility` 是 UI／JSON 共用的 window scope 物件；舊的 `modelFilter` 已移除（使用者 2026-10-25 決定）。以 inspect 明確值判斷，不用 manifest default 或 get 的合併物件；缺設定時預設 Anthropic＋OpenAI、版本不限。Workspace 物件完整取代 User，User 內的本機／Remote User 合併依 VS Code；無效物件採空選取並保留診斷，不當成全部。選單只詢問已選供應商的版本門檻，selected 模式儲存時清除未選供應商的既有門檻；GPT 門檻設定時同時隱藏 GPT-OSS 系列。反例：無效物件被當成全部，或留下未選供應商的舊門檻。
- Settings manifest 順序固定為 `profile`、`region`、`inferenceScope`、`modelVisibility`、`modelPresets`、`usageResetDay`、`usageResetHour`、`customPricing`，`order` 依序 1–8。
- 不可複製三個參考 extension（`arifum.bedrock-vscode-chat`、`easytocloud.bedrock-mantle-vscode-chat`、`abhimanyus1997.bedrock-bridge-copilot`）的程式碼，只能參考做法。理由：使用者的決定。
- Credential 一律交給 AWS SDK provider（如 `fromIni({ profile })`），每次請求都透過 provider 取得；不可把 `accessKeyId`、`secretAccessKey`、`sessionToken` 存進自己的變數或快取重用。理由：參考 extension 在 SSO 過期後不會重新整理，就是這個原因。
- SSO token 過期（`ExpiredTokenException`、`TokenRefreshRequired`、`CredentialsProviderError` 等）時，顯示明確錯誤並提示執行 `aws sso login --profile <name>`，提供「登入」按鈕；不可只回一般錯誤，也不可無聲重試。只有使用者按下按鈕才執行 `aws sso login`，不可背景自動執行，也不可自動重送失敗的 Chat 請求。理由：自動開瀏覽器會嚇到使用者，而 VS Code 會頻繁在背景查詢模型清單。
- 回報給 VS Code 的 `maxInputTokens`、`maxOutputTokens` 必須有來源（AWS 文件或 API 回傳值）並在程式碼註解標明；無來源的模型用保守值並寫進 log。不可從模型名稱推測（反例：看到 `claude` 就回報 200K）。理由：參考 extension 回報錯誤的 context window。
- 模型呼叫失敗時，錯誤訊息要包含 model ID、呼叫路徑（目前固定為 Native）與 AWS 回傳的原始錯誤碼。理由：參考 extension 有部分模型失敗卻無從判斷原因。
- 只有與帳號無關的失敗才能在 `PROBED_CAPABILITIES` 用 `unsupported` 排除模型（已下線用 `retired`，不支援 Converse 用 `noConverse`，實測不支援工具用 `tools: false`）。帳號權限或帳號設定造成的失敗一律不排除，因為別的帳號可能可以用。反例：Pegasus 1.5 因 `AccessDeniedException`（Marketplace 訂閱或帳號不開放）不可排除；Fable 的 data retention mode（需帳號設為 `aws_review`）不可排除；Sonnet 4 的「Legacy 且 30 天未使用」不可排除。理由：排除是全域的，會替所有使用者隱藏模型。

## Known Pitfalls

- 不要為了「讓受限模式可用」而宣告 `capabilities.untrustedWorkspaces`：Restricted Mode 下 VS Code Chat 自己封鎖所有模型（顯示「Models unavailable while in Restricted mode」），宣告 `limited` 也無法改變（2026-10-09 實測）。未宣告時 extension 在受限模式停用，屬預期行為，資安審查不必列為發現。
- `bedrock-runtime` Native 路徑已實測可用 SSO profile：控制面 `list-inference-profiles` 與 runtime `ConverseStream` 都成功（2026-09-25，`us-west-2`）。
- 這台電腦按 F5 時，Extension Development Host 視窗出現 `command '...' not found` 是假線索：真因是 js-debug 連 `::1:<port>` 被拒（`ECONNREFUSED`），Extension Host 60 秒後逾時，沒有任何 extension 在執行。不要往指令註冊、`package.json`、VPN 或 proxy 方向追（換個人網路結果相同）。確認方式：主視窗 `exthost.log` 有 `ECONNREFUSED ::1`，開發視窗 `renderer.log` 有 `Extension host did not start`。本機實測：`localhost` 先解析成 `::1`，只在 `127.0.0.1` 監聽的偵錯埠連 `::1` 會被拒。改用 `Ctrl+Shift+B` 的 `Open Extension Development Host`（先編譯再執行 `code --new-window --extensionDevelopmentPath=<repo>`，不能設中斷點）。（2026-09-25 發生三次）



