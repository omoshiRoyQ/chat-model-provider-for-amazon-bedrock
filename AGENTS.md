# chat-model-provider-for-amazon-bedrock

VS Code extension，實作 `LanguageModelChatProvider`，把 Amazon Bedrock 模型接進 VS Code Chat 模型選單。只使用 `bedrock-runtime` endpoint 的 AWS SDK Native ConverseStream API；不使用 `bedrock-mantle` endpoint，也不使用 `bedrock-runtime` 上的 OpenAI 相容 Chat Completions／Responses 或 Anthropic Messages API。TypeScript、pnpm、esbuild。本文件可獨立接手，所有必要規則均在本檔或 repo 相對路徑內。

## Environment and Permissions

- 認證只使用使用者指定的 AWS named profile，透過 AWS SDK 的 `fromIni({ profile })` 取得憑證，支援 SSO。不支援 API key、直接提供 access key 或 SDK default credential chain；除非使用者明確提出需求，否則不得擴充。理由：使用者選擇安全性優先於泛用性，避免增加憑證儲存與選擇路徑。
- 測試用的 profile 名稱與 region 由使用者提供，不可寫死在程式碼或測試中。
- `profile`、`region`、`inferenceScope` 設定刻意不宣告 `scope`，受信任專案的 `.vscode/settings.json` 可以覆寫。這不算資安問題，資安審查不必列出。理由：使用者的決定（2026-10-04）；專案只能指定名稱，認證仍只能用使用者 `~/.aws/config` 裡既有的 profile。`modelVisibility`、`modelPresets`、`customPricing`、`usageResetDay`、`usageResetHour` 同樣可被受信任專案覆寫，屬同一項決定（2026-10-25），資安審查不必列出；影響是專案可顯示較貴的模型，或壓低費用估算。`proxyUrl` 則宣告為 `machine` scope，避免工作區設定覆寫網路代理路徑，且刻意不讀取 `HTTP_PROXY`／`HTTPS_PROXY` 等泛用環境變數、不接受網址內嵌帳密（2026-11-19 決定）。

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
- 證據層級：單元測試、編譯、安裝後 VSIX 互不替代；實測與發布驗收統一以封裝 VSIX 安裝後操作確認（不維護 `.vscode/` 啟動設定或 Extension Development Host 腳本，2026-11-28 決定）。
- VSIX：`.vscodeignore` 以白名單控制內容。`pnpm run package:verified`（全部單元測試 → package → package:ls）任一步失敗即停止；`package` 先確保 `.tmp` 目錄存在再執行 `vsce package --no-dependencies --out .tmp`，由 `vscode:prepublish` 各執行一次 typecheck、check 與 production build，不要先接 `verify` 重複檢查。`verify` 是不封裝的完整驗證，`package:ls` 只列內容；皆不取代安全／發布審查或安裝後驗收。
- 測試預期值來自 AWS 文件、實測的 AWS 回應或使用者決定，並在測試檔註明來源；不可用程式自己算出的結果當預期值。
- `verify` 不可包含 `check-model-cards`、`probe-models`（後者會送計費請求，前者帶 `--profile` 時也會）。探測結果寫入 `.tmp/probe-models-results.txt`，每次覆寫、不進 Git（使用者 2026-10-21 決定）。
- 模型能否出現在 Chat 選單、Agent 模式能否呼叫 tool，只能由使用者在 VS Code 內操作確認；回報時說明尚未驗證。
- 冷煙測試（安裝 VSIX 後）：`Show Logs` 有 `Extension activated`；Chat 模型選單出現 Amazon Bedrock 模型；對便宜模型送一則短訊息有回應且狀態列 token 數增加；Agent 模式呼叫一次工具；使用量面板可開啟。
- AWS CLI 驗證權限優先用不計費的控制面 API（`list-inference-profiles`、`list-foundation-models`）；必須測 runtime 時用 `maxTokens=1` 並挑便宜模型。

## Documentation and Localization

- 使用者文件及介面維持 EN／TW／JA，EN 為預設，對應 `en-US`（美式英文）、`zh-TW`（臺灣中文字形與臺灣用語）、`ja-JP`（日文常用漢字，不套用臺灣中文字形規則），外顯標示只寫 EN／TW／JA；README 與 CHANGELOG 各有 `.md`、`.zh-tw.md`、`.ja.md`。修改任一語言時同步另外兩語並維持章節／條目對應；無法同步則明列未完成，不改寫歷史條目。
- Manifest 字串使用 `package.nls.json`、`package.nls.zh-tw.json`、`package.nls.ja.json`；執行期字串以英文原文作為 `vscode.l10n.t` key，翻譯放在 `l10n/bundle.l10n.zh-tw.json` 與 `l10n/bundle.l10n.ja.json`，不建立英文 bundle。修改 UI 或字串時同步翻譯並執行 `pnpm run check:l10n`；動態訊息仍須人工核對。
- thinking effort 的 `Default` 在 EN／TW／JA 均保留英文，選單與重設說明一致；這是語系例外，不改內部 `default` 值、儲存格式或模型請求。反例：TW 翻成「預設」、JA 翻成「既定」。

## Project-specific Rules

Bedrock 專屬流程在 `.agents/skills/update-catalog/`。

## Pricing

- 價格來源依序是：使用者的 `customPricing`、AWS 公開價格檔 `AmazonBedrockFoundationModels/current/<region>/index.json`（不需要 `pricing:*` 權限）、AWS model card 的 Pricing 段落。model card 是使用者同意的第二來源（2026-10-04），理由是 GPT-6 Astra 的 card 價格與價格檔完全相同，而其他 GPT 只在 card 上有價格。兩個來源都查不到的單價不可自行推測，也不可用 OpenAI 官方價格換算。
- card 的表格解析失敗時視為沒有價格，修正 `src/modelCards.ts`；`check-model-cards` 會列出 `has a price table that failed to parse` 的 card。
- 價格檔的 region 一律用設定值，沒有設定時用 SDK 從 profile 解析到的值，不可寫死 `us-west-2`。
- long-context 價格：單一請求的輸入超過門檻時，整個請求都用 long-context 單價。門檻寫在 CATALOG 的 `longContextThreshold`，每次記錄使用量時就分類，因為累計後就分不出來。判斷用的是總輸入（含快取讀取與寫入），這是使用者的決定（2026-10-04）。理由：card 沒寫快取算不算，寧可多估也不要少估；費用本來就是估算，有人回報與帳單不符再改。
- 門檻來源：GPT 取自 model card 的 Pricing 段落（272K）。Claude 目前只有 Haiku 5.5 有這一層，門檻 100K 取自 Anthropic 官方價格頁（`platform.claude.com/docs/en/about-claude/pricing` 的「prompts over 100,000 tokens」），因為 AWS 的 card 與價格頁都沒寫門檻；這是使用者的決定（2026-10-09）。AWS 公開價格檔有 `_long_ctx` 單價可佐證有這一層，但不含門檻。反例：看到價格檔有 `_long_ctx` 就沿用 GPT 的 272K。
- 依 Geo、Global 或 In-Region 路由選價，查 `src/pricing.ts` 的 `lookupPrice`。
- cache read 與 cache write 必須各自套用對應單價。例：input 4、cacheRead 0、cacheWrite 35,463、output 931；每百萬單價依序為 input $4、read $0.2、write $5、output $20，估算為 $0.195951，畫面顯示 $0.1960。
- 區域價格表由使用者按 Update Prices 後下載並按 region 儲存在 Default Profile 通用區（`shared-prices.json`），沒有內建價格表。cost 是估算值，畫面顯示到小數點後四位，實際費用以 AWS 帳單為準。

## Release Approval

- 封裝前先確認使用者對 `/security-review` 與 `/release-audit` 的選擇（使用者執行、代理執行或略過）；回答前不封裝，略過不代表稽核通過。
- Marketplace 發布、版本更新、三語 CHANGELOG 更新與 VSIX 安裝驗收依使用者明確要求執行；Marketplace 發布與 Git 寫入由使用者執行。不封裝用 `verify`，需 VSIX 用 `package:verified`，兩者不重複；核對 VSIX 不含 `src`、`test`、`node_modules`，失敗時不得把舊產物當成新成品。

## Release Notes Format

- CHANGELOG 每項變更用一至兩句完整句子描述使用者可見行為，不加 Added／Fixed 等分類；三語檔案結構、條目數與順序相符。新版沿用前版樣式並置頂，不改寫歷史。
- GitHub release 本文用英文，條目取自該版 CHANGELOG；只有變更涉及資料／網路、權限／登入、升級手動步驟或費用時，才加注意事項。發布說明草稿不代表已發布。
- `## Other languages`：`[TW](…/blob/<tag>/CHANGELOG.zh-tw.md) | [JA](…/blob/<tag>/CHANGELOG.ja.md)`，連結固定在本次 tag、不連 `main`；語言代號為 EN、TW、JA。
- 連結前綴：`https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock/blob/<tag>/`。附件：對應該版建置的 `chat-model-provider-for-amazon-bedrock-<version>.vsix`。

## Code Conventions

- `modelVisibility` 是 UI／JSON 共用的 window scope 物件；舊的 `modelFilter` 已移除（使用者 2026-10-25 決定）。以 inspect 明確值判斷，不用 manifest default 或 get 的合併物件；缺設定時預設 Anthropic＋OpenAI、版本不限。Workspace 物件完整取代 User，User 內的本機／Remote User 合併依 VS Code；無效物件採空選取並保留診斷，不當成全部。選單只詢問已選供應商的版本門檻，selected 模式儲存時清除未選供應商的既有門檻；GPT 門檻設定時同時隱藏 GPT-OSS 系列。反例：無效物件被當成全部，或留下未選供應商的舊門檻。
- Settings manifest 順序固定為 `profile`、`region`、`inferenceScope`、`modelVisibility`、`modelPresets`、`usageResetDay`、`usageResetHour`、`customPricing`、`proxyUrl`，`order` 依序 1–9。
- 使用量統計集中儲存於 Default Profile 的擴充功能 `globalStorage` 共用檔案（version 1 `shared-usage.json`，仍依 AWS `profile` 名稱分組）；下載的區域價格表與 Model Card 快取亦同置於該通用目錄的獨立檔案（`shared-prices.json`、`shared-model-cards.json`），各有獨立的 Node 內建 SQLite 寫入鎖（SQLite 不存資料）、原子寫入、外部變更 watcher 與一次性 `globalState` 舊資料遷移（不覆蓋共用區既有資料，2026-11-28 決定）。若沒有可共用的本機路徑、鎖逾時或寫入失敗，該筆本機用量不儲存、價格與 Model Card 下載則直接拋錯，均不另存各 Profile 的 `globalState`。Chat 回應同時以 `mimeType: 'usage'` 的 `LanguageModelDataPart` 回報 token 數，不帶 Copilot 計費欄位以免混入 Copilot AI Credits（2026-11-23 決定）。
- Bedrock 與認證子請求都忽略 AWS SDK 的自訂 endpoint 設定，只連 SDK 預設 HTTPS endpoint；Proxy 只由 machine scope 的 `proxyUrl` 明確設定。直連、HTTPS proxy 與 proxy tunnel 後的目的端都必須驗證 TLS 憑證，不因 Node 環境的設定略過驗證。
- 不可複製三個參考 extension（`arifum.bedrock-vscode-chat`、`easytocloud.bedrock-mantle-vscode-chat`、`abhimanyus1997.bedrock-bridge-copilot`）的程式碼，只能參考做法。理由：使用者的決定。
- Credential 一律交給 AWS SDK provider（如 `fromIni({ profile })`），每次請求都透過 provider 取得；不可把 `accessKeyId`、`secretAccessKey`、`sessionToken` 存進自己的變數或快取重用。理由：參考 extension 在 SSO 過期後不會重新整理，就是這個原因。
- SSO token 過期（`ExpiredTokenException`、`TokenRefreshRequired`、`CredentialsProviderError` 等）時，顯示明確錯誤並提示執行 `aws sso login --profile <name>`，提供「登入」按鈕；不可只回一般錯誤，也不可無聲重試。只有使用者按下按鈕才執行 `aws sso login`，不可背景自動執行，也不可自動重送失敗的 Chat 請求。理由：自動開瀏覽器會嚇到使用者，而 VS Code 會頻繁在背景查詢模型清單。
- 回報給 VS Code 的 `maxInputTokens`、`maxOutputTokens` 必須有來源（AWS 文件或 API 回傳值）並在程式碼註解標明；無來源的模型用保守值並寫進 log。不可從模型名稱推測（反例：看到 `claude` 就回報 200K）。理由：參考 extension 回報錯誤的 context window。
- 模型呼叫失敗時，錯誤訊息要包含 model ID、呼叫路徑（目前固定為 Native）與 AWS 回傳的原始錯誤碼。理由：參考 extension 有部分模型失敗卻無從判斷原因。
- 只有與帳號無關的失敗才能在 `PROBED_CAPABILITIES` 用 `unsupported` 排除模型（已下線用 `retired`，不支援 Converse 用 `noConverse`，實測不支援工具用 `tools: false`）。帳號權限或帳號設定造成的失敗一律不排除，因為別的帳號可能可以用。反例：Pegasus 1.5 因 `AccessDeniedException`（Marketplace 訂閱或帳號不開放）不可排除；Fable 的 data retention mode（需帳號設為 `aws_review`）不可排除；Sonnet 4 的「Legacy 且 30 天未使用」不可排除。理由：排除是全域的，會替所有使用者隱藏模型。

## Known Pitfalls

- 不要為了「讓受限模式可用」而宣告 `capabilities.untrustedWorkspaces`：Restricted Mode 下 VS Code Chat 自己封鎖所有模型（顯示「Models unavailable while in Restricted mode」），宣告 `limited` 也無法改變（2026-10-09 實測）。未宣告時 extension 在受限模式停用，屬預期行為，資安審查不必列為發現。
- `bedrock-runtime` Native 路徑已實測可用 SSO profile：控制面 `list-inference-profiles` 與 runtime `ConverseStream` 都成功（2026-09-25，`us-west-2`）。
- 這台電腦按 F5 時，Extension Development Host 視窗出現 `command '...' not found` 是假線索：真因是 js-debug 連 `::1:<port>` 被拒（`ECONNREFUSED`），Extension Host 60 秒後逾時，沒有任何 extension 在執行（2026-09-25 發生三次）。專案已移除 `.vscode/` 與開發 Host 腳本，統一改以封裝 VSIX 後安裝測試（2026-11-28 決定）。



