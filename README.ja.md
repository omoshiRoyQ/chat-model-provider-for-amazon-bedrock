# Chat Model Provider for Amazon Bedrock

[EN](README.md) | [TW](README.zh-tw.md)

指定した AWS 名前付きプロファイル（SSO 対応）を使用して、VS Code Chat で Amazon Bedrock のモデルを利用できます。API key は使用も保存もせず、extension は telemetry を送信しません。Chat リクエストは Amazon Bedrock に送信され、使用量、モデルごとの thinking 設定、ダウンロードした価格表は VS Code のローカル extension storage に保存されます。

この extension は `bedrock-runtime` endpoint の Native ConverseStream API のみを使用します。`bedrock-mantle` endpoint、および `bedrock-runtime` で利用できる OpenAI 互換 Chat Completions／Responses API と Anthropic Messages API は使用しません。

## 機能

- AWS アカウントから利用可能な Bedrock モデルを取得し、地理的またはグローバルな推論プロファイルを選択できます。
- Claude、GPT などの対象モデルを利用できます。Claude と GPT のみ、または対象モデルすべてを表示できます。
- 対応モデルでは Chat Agent の tool calling と画像入力を利用できます。
- モデルごとに thinking effort を設定できます。未対応の設定は extension 側で調整されるか、Bedrock に拒否される場合があります。
- ステータスバーに今期の入力／出力 token 数を、使用量パネルにモデルごとのリクエスト数、token 数（プロンプトキャッシュの読み取りと書き込みを含む）、推定費用を表示します。
- プロンプトキャッシュに対応した Claude モデルでは Bedrock の prompt caching を使用し、繰り返し送信される会話内容をキャッシュから読み取れるようにします。
- 価格表の更新、独自価格の設定、月次使用量リセットの日付と UTC 時刻の設定ができます。

## 必要条件

- VS Code 1.106 以降。
- AWS CLI v2 と設定済みの AWS プロファイル。この extension は AWS プロファイルのみを使用し、API key や直接入力した access key は受け付けません。
- AWS アカウントで Amazon Bedrock が有効であり、選択したモデルを設定済みのリージョンと推論範囲で利用できること。

## セットアップ

1. AWS CLI v2 で SSO プロファイルを設定します。
   ```powershell
   aws configure sso
   ```
2. プロファイルにサインインします。
   ```powershell
   aws sso login --profile bedrock
   ```
3. VS Code 設定の `amazonBedrockProvider.profile` に `bedrock` などのプロファイル名を入力します。プロファイルにリージョンが設定されていない場合は、`amazonBedrockProvider.region` も設定します。
4. Chat のモデル選択を開き、Amazon Bedrock のモデルを選択して会話を開始します。

## AWS 権限

| 権限 | 用途 | 必須 |
| --- | --- | --- |
| `bedrock:ListInferenceProfiles` | 呼び出せるモデルの一覧を取得 | 必須 |
| `bedrock:InvokeModelWithResponseStream` | モデルとストリーミングで会話 | 必須 |
| `bedrock:ListFoundationModels` | 画像対応の有無など、モデルの機能を取得 | 推奨 |

`bedrock:ListFoundationModels` がなくても会話はできますが、次の違いがあります。

- **画像**：モデルごとに、利用可能な最初の情報源を採用します。extension に組み込まれた画像の実測結果、次に `bedrock:ListFoundationModels` が返す `inputModalities`。どちらも情報がない場合、そのモデルは画像の添付を許可します。モデルが画像に対応していない場合は、送信後にエラーが表示されます。画像非対応と判断されたモデルには画像が送信されず、extension が代わりにテキストの注記を送ります。Agent の tool が返す画像（スクリーンショットなど）も同じ規則に従います。
- **モデル一覧**：ID が `us.` や `global.` などのプレフィックスで始まるモデルのみ表示されます。モデル ID で直接呼び出すしかないモデル（例：`openai.gpt-oss-20b-1:0`）は表示されません。
- **Model Filter ですべてのモデルを表示する場合**：画像生成や embedding など、会話できないモデルも選択肢に表示されます。

既定の Claude と GPT のみの表示では、主な違いは画像の扱いだけです。

一部のサードパーティ Marketplace モデルでは、`aws-marketplace:ViewSubscriptions` と `aws-marketplace:Subscribe` に加え、そのモデルのサブスクリプションが必要です。resource ARN と条件は、利用するモデル、リージョン、組織のポリシーに合わせて AWS 管理者が設定してください。

モデル一覧の権限を確認するには、ご自身のプロファイルとリージョンを指定して次のコマンドを実行します。これらのコマンドはモデルを呼び出さず、料金も発生しません。

```powershell
aws bedrock list-inference-profiles --profile <profile> --region <region>
aws bedrock list-foundation-models --profile <profile> --region <region>
```

1 つ目のコマンドが失敗する場合、モデル一覧を読み込めません。2 つ目のコマンドだけが失敗する場合は、上記の違いはありますが会話はできます。これらのコマンドでは `bedrock:InvokeModelWithResponseStream` を確認できません。この権限を確認するには、Chat でメッセージを送信してください。

## 設定

- **Model Filter**：Claude と GPT のみ、または対象モデルすべてを表示します。
- **Inference Scope**：`geo` は地理的推論プロファイルを使用し、グローバルプロファイルしかないモデルは表示されません。`global` はグローバルプロファイルを優先し、世界中の AWS リージョンにリクエストがルーティングされる場合があります。グローバルプロファイルがないモデルは地理的プロファイルを使用します。
- **Usage Reset Day／Hour**：月次リセットの日（1～31）と UTC 時刻（0～23）を設定します。その月に指定日がない場合は月末にリセットします。スケジュールを変更しても使用量はすぐに消去されず、新しいスケジュールの次回リセット時に消去されます。
- **Custom Pricing**：モデル ID ごとに、100 万 token あたりの米ドル価格を設定します。独自価格はダウンロードした価格表より優先されます。`cacheRead` と `cacheWrite` は省略可能なプロンプトキャッシュの価格です。省略した場合、プロンプトキャッシュを読み書きしたリクエストの費用は推定しません。例：

  ```json
  {
    "openai.gpt-6-astra": {
      "input": 5,
      "output": 20
    }
  }
  ```

## 使用量と費用

Bedrock が返す入力／出力 token 数を AWS プロファイル、モデル、推論 route ごとに累計します。費用は推定値で、AWS の請求額ではありません。実際の料金は AWS の請求書で確認してください。**価格を更新** を選択すると、AWS 公開価格表と AWS モデルカードの価格表をダウンロードします。単価は独自価格、公開価格表、モデルカードの順に取得するため、公開価格表にない GPT モデルも費用を推定できます。モデルカードの価格を使った費用には **モデルカード** と表示されます。いずれにも価格がないモデルは **価格データなし** と表示されます。

一部の GPT モデルでは、1 回のリクエストの入力が 272K token を超えると、リクエスト全体にロングコンテキスト価格が適用されます（各モデルカードの記載による）。Claude Haiku 5.5 も 100K token を超えると同様です（Anthropic の価格ページの記載による。AWS のモデルカードには境界値の記載がありません）。extension はリクエストを記録するたびに、キャッシュの読み取りと書き込みも入力に含めて判定し、超えたリクエストはロングコンテキストの単価で計算します。このバージョンより前に記録された使用量は通常の単価で計算します。独自価格にはロングコンテキストの区分がないため、ロングコンテキストのリクエストがあり独自価格しかないモデルは **ロングコンテキスト価格なし** と表示されます。

[AWS ドキュメント](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)でプロンプトキャッシュ対応とされている Claude モデルでは、tool 定義、システムプロンプト、最新メッセージの末尾に cache point を追加します。GPT などほかのモデルも、モデル側でキャッシュの読み取りや書き込みを報告する場合があります。使用量パネルの **入力トークン** は **入力**（キャッシュなし）、**キャッシュ読み取り**、**キャッシュ書き込み** の 3 列に分かれ、足すと入力の合計になります。ステータスバーにはその合計を表示します。キャッシュの読み取りと書き込みは別の単価で計算します。キャッシュ単価は公開価格表またはモデルカードから取得します（GPT のキャッシュ書き込みは 30 分の単価）。以前のバージョンで価格をダウンロードした場合は、もう一度 **価格を更新** を選択してください。キャッシュ token があるのにキャッシュ単価がないモデルは、費用に **キャッシュ価格なし** と表示され、合計には含まれません。

ステータスバーには今期の入力／出力 token 数が表示されます。token 数を選択すると使用量パネルが開き、価格の更新、独自価格設定の表示、使用量のリセットができます。

## セキュリティとプライバシー

### テレメトリーとネットワーク通信

この extension は telemetry を実装・送信せず、分析データを作者に送信しません。Chat の内容は下記のとおり Amazon Bedrock に送信されます。extension が行うネットワークリクエストは次のとおりです。

1. AWS プロファイルを通じた、選択したリージョンの Amazon Bedrock への接続（モデル一覧の読み込みとストリーミング Chat）。
2. **価格を更新** を選択したときの、AWS 公開価格ファイルへの HTTPS GET リクエスト。リクエストにアカウント情報や AWS 認証情報は含まれません。
3. AWS 公開ドキュメント（docs.aws.amazon.com）のモデルカードページへの HTTPS GET リクエスト。コンテキストウィンドウ、最大出力 token 数、価格を読み取ります。モデル一覧に内蔵リストにないモデルが含まれる場合はバックグラウンドで読み取り（7 日間キャッシュ）、**価格を更新** を選択したときはすべてのモデルカードを読み直します。リクエストにアカウント情報や AWS 認証情報は含まれません。

サインインボタンを選択すると、extension はローカルで AWS CLI の `aws sso login` を起動し、AWS CLI がブラウザーを開いてサインインを完了させます（アカウントの選択やアクセスの承認など）。バックグラウンドで自動的にサインインすることはありません。

VS Code 自体の telemetry は VS Code の `telemetry.telemetryLevel` 設定に従い、この extension では制御しません。

### AWS 認証情報

- 指定した AWS 名前付きプロファイルのみを使用します。API key やアクセスキーの直接入力には対応していません。
- 認証情報はリクエストごとに AWS SDK がプロファイルを通じて取得します。この extension は access key、secret key、session token、SSO token を VS Code 設定、`globalState`、ログに保存しません。
- SSO サインインは AWS CLI が処理します。AWS SDK はプロファイルを解決するために `~/.aws/config` と `~/.aws/credentials` を読み取り、SSO token の期限が近づくと、AWS CLI と同様に `~/.aws/sso/cache/` の token を更新する場合があります。この extension がほかの AWS ファイルを変更することはありません。

### 会話の内容

- Chat のメッセージ、tool の結果、添付ファイルは、ご自身の AWS アカウントの Amazon Bedrock にのみ送信され、IAM 権限、AWS の請求、AWS の規約の下で管理されます。
- AWS のドキュメントによると、モデルプロバイダーは Amazon Bedrock の顧客のプロンプトと応答にアクセスできません。詳しくは [Amazon Bedrock Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html) を参照してください。
- 推論範囲を `global` にすると、リクエストが世界各地の AWS リージョンにルーティングされる場合があります。データの所在地に要件がある場合は `geo` を使用してください。
- プロンプトキャッシュ対応の Claude モデルでは、後続のリクエストで再利用できるよう、Bedrock がキャッシュしたプロンプトの先頭部分を 5 分間（既定の TTL）保持します。

### ローカル保存

- VS Code `globalState` に保存するのは、使用量（プロファイル名、model ID、token 数、リクエスト数）、モデルごとの thinking 設定、ダウンロードした価格表、AWS モデルカードから読み取った token 上限と価格のみです。これらはほかのデバイスに同期されません。使用量は使用量パネルからリセットでき、thinking 設定は **thinking effort を設定** コマンドで Default に戻せます。ダウンロードした価格表は、**価格を更新** を選択すると新しい価格表に置き換えられます。
- Chat の内容をローカル保存やログに書き込むことはありません。

### ログ

- **ログを表示** で確認できるログに記録されるのは、プロファイル名、リージョン、model ID、メッセージ数、tool 名、エラーコードなどの診断情報のみで、Chat の内容は記録しません。エラーメッセージ中の AWS principal ARN とメールアドレスは伏せ字にします。
- ログには AWS CLI のサインイン出力が含まれます。URL のパラメーター、Start URL 内の組織名、メールアドレスは `[redacted]` に置き換えられます。ログを共有する前に、個人情報が含まれていないか確認してください。サインイン時にブラウザーが開かない場合は、ターミナルで `aws sso login --profile <profile>` を実行してください。

### オープンソース

ソースコードは MIT ライセンスで [GitHub](https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock) に公開しており、ご自身で確認やビルドができます。セキュリティ上の問題は、リポジトリの GitHub Security ページから非公開で報告してください。公開 issue に AWS 認証情報やログを貼らないでください。

## トラブルシューティング

- **AWS リージョンが設定されていません**：VS Code 設定の `amazonBedrockProvider.region`、または AWS プロファイルにリージョンを設定してください。
- **モデル一覧の権限が不足している**：管理者に `bedrock:ListInferenceProfiles` の付与を依頼してください。
- **モデル呼び出しが拒否される**：プロファイルに `bedrock:InvokeModelWithResponseStream` があり、モデルが選択したリージョンと推論範囲で利用可能か確認してください。Marketplace モデルではサブスクリプション権限も必要な場合があります。
- **SSO のサインイン期限が切れた**：Bedrock のサインインボタンを選択するか、`aws sso login --profile <profile>` を実行してから、失敗した Chat リクエストを再送してください。
- **詳細な診断情報**：コマンドパレットから **ログを表示** を実行してください。ログを共有する前に個人情報と検証情報を伏せてください。

## ライセンス

本プロジェクトは MIT ライセンスです。詳しくは [LICENSE](LICENSE) を参照してください。同梱する依存パッケージのライセンスと著作権表示は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) を参照してください。

本プロジェクトは作者が一人でメンテナンスしています。fork してご自身のプロジェクトにすることは歓迎します。その際は本プロジェクトを出典として明記し、MIT ライセンスに基づき著作権表示とライセンス表示を残してください。

Amazon Bedrock および AWS は Amazon.com, Inc. またはその関連会社の商標です。本プロジェクトは独立したものであり、Amazon.com, Inc. または AWS との提携関係はなく、承認や後援も受けていません。