# Chat Model Provider for Amazon Bedrock

[TW](README.zh-tw.md) | [JP](README.ja.md)

Use Amazon Bedrock models in VS Code Chat with your AWS named profile (SSO supported). No API keys are used or stored, and the extension sends no telemetry. Chat requests go to Amazon Bedrock; usage totals, per-model thinking settings, and downloaded pricing data are stored in VS Code's local extension storage.

This extension uses only the Native ConverseStream API on the `bedrock-runtime` endpoint. It does not use the `bedrock-mantle` endpoint or the OpenAI-compatible Chat Completions/Responses or Anthropic Messages APIs available on `bedrock-runtime`.

## Features

- Loads available Bedrock models from your AWS account and supports geographic or global inference-profile routing.
- Supports Claude, GPT, and other eligible models, with a filter for Claude and GPT or all eligible models.
- Supports Chat Agent tool calling and image input for models that support it.
- Lets you set thinking effort per model. Unsupported settings may be adjusted by the extension or rejected by Bedrock.
- Shows this period's input and output tokens in the status bar, and per-model request counts, tokens, and estimated costs in the usage panel.
- Lets you update the price table, set custom prices, and configure the monthly usage reset day and UTC hour.

## Requirements

- VS Code 1.106 or later.
- AWS CLI v2 and a configured AWS profile. This extension uses AWS profiles only; it does not accept API keys or directly entered access keys.
- Amazon Bedrock enabled for your AWS account, with the selected model available in the configured region and inference scope.

## Setup

1. Configure an SSO profile with AWS CLI v2:
   ```powershell
   aws configure sso
   ```
2. Sign in to the profile:
   ```powershell
   aws sso login --profile bedrock
   ```
3. Set `amazonBedrockProvider.profile` in VS Code settings to the profile name, such as `bedrock`. Set `amazonBedrockProvider.region` if the profile does not specify a region.
4. Open the Chat model picker, select an Amazon Bedrock model, and start chatting.

## AWS Permissions

The following permissions are needed to list models and use streaming chat:

- `bedrock:ListInferenceProfiles`
- `bedrock:ListFoundationModels`
- `bedrock:InvokeModelWithResponseStream`

Some third-party Marketplace models also require `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe`, as well as a completed subscription for the model. Ask your AWS administrator to scope resource ARNs and conditions to your models, region, and organization policies.

## Settings

- **Model Filter**: Show only Claude and GPT, or all eligible models.
- **Inference Scope**: `geo` uses a geographic inference profile and hides models that offer only a global profile. `global` prefers a global profile, which may route requests to AWS Regions worldwide, and falls back to the geographic profile when a model has no global profile.
- **Usage Reset Day / Hour**: Set the monthly reset day (1–31) and UTC hour (0–23). If a month does not have the selected day, usage resets on the month's last day. Changing the schedule does not immediately clear usage; it resets at the next reset time under the new schedule.
- **Custom Pricing**: Set USD prices per million tokens by model ID. Custom prices take precedence over the downloaded price table. For example:

  ```json
  {
    "openai.gpt-6-astra": {
      "input": 5,
      "output": 20
    }
  }
  ```

## Usage and Costs

Input and output token usage reported by Bedrock is accumulated by AWS profile, model, and inference route. Costs are estimates, not AWS billing data; actual charges are shown on your AWS bill. Models without public AWS pricing, such as GPT, require custom prices for cost estimates.

The status bar shows this period's input and output tokens. Select the token totals to open the usage panel, where you can update prices, open custom pricing settings, or reset usage.

## Security and Privacy

### Telemetry and Network Access

This extension does not implement or send telemetry, and it does not send analytics data to the author. Chat content is sent to Amazon Bedrock as described below. The extension makes these network requests:

1. Amazon Bedrock in the selected region, through your AWS profile (loading the model list and streaming chat).
2. An HTTPS GET request to the public AWS price file when you select **Update Prices**. The request contains no account information or credentials.

When you select the sign-in button, the extension starts AWS CLI `aws sso login` locally. The extension never starts sign-in automatically in the background.

VS Code's own telemetry follows the VS Code `telemetry.telemetryLevel` setting and is not controlled by this extension.

### Credentials

- Only the AWS named profile you specify is used. API keys and directly entered access keys are not supported.
- The AWS SDK resolves credentials through the profile for every request. The extension never stores access keys, secret keys, session tokens, or SSO tokens in VS Code settings, `globalState`, or logs.
- AWS CLI handles SSO sign-in. The AWS SDK reads `~/.aws/config` and `~/.aws/credentials` to resolve the profile, and may refresh an SSO token that is about to expire in `~/.aws/sso/cache/`, as AWS CLI does. The extension does not modify any other AWS files.

### Your Conversations

- Chat messages, tool results, and attachments are sent only to Amazon Bedrock in your own AWS account, governed by your IAM permissions, your AWS bill, and the AWS terms.
- According to AWS documentation, model providers have no access to Amazon Bedrock customer prompts and completions. See [Amazon Bedrock Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html).
- With the `global` inference scope, requests may be routed to AWS regions worldwide. Use `geo` if you have data residency requirements.

### Local Storage

- VS Code `globalState` stores only usage totals (profile name, model ID, token and request counts), per-model thinking settings, and downloaded price tables. This data is not synced to other devices. Reset usage totals from the usage panel and thinking settings with **Set Thinking Effort**; downloaded price tables are replaced when you select **Update Prices**.
- The extension does not write chat content to local storage or logs.

### Logs

- `Show Logs` records only diagnostics such as profile name, region, model ID, message counts, tool names, and error codes, never chat content. AWS principal ARNs and email addresses in error messages are redacted.
- Logs may include AWS CLI sign-in output. Review and redact login URLs, verification codes, and personal information before sharing logs.

### Open Source

The source code is available on [GitHub](https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock) under the MIT license, so you can review or build it yourself. Report security issues privately through the repository's GitHub Security page, and never post credentials or logs in public issues.

## Troubleshooting

- **No AWS Region is configured**: Set `amazonBedrockProvider.region` in VS Code settings or configure a region in your AWS profile.
- **Model list permissions are missing**: Ask your administrator to grant `bedrock:ListInferenceProfiles` and `bedrock:ListFoundationModels`.
- **Model invocation is denied**: Check that the profile has `bedrock:InvokeModelWithResponseStream` and that the model is available in the selected region and inference scope. Marketplace models may also require subscription permissions.
- **SSO sign-in has expired**: Select the Bedrock sign-in button or run `aws sso login --profile <profile>`, then resend the failed Chat request.
- **Detailed diagnostics**: Run **Show Logs** from the Command Palette. Redact personal information and verification details before sharing logs.

## License

This project is licensed under MIT; see [LICENSE](LICENSE). Licenses and copyright notices for bundled dependencies are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Amazon Bedrock and AWS are trademarks of Amazon.com, Inc. or its affiliates. This independent project is not affiliated with, endorsed by, or sponsored by Amazon.com, Inc. or AWS.