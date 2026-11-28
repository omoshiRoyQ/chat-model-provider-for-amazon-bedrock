# Chat Model Provider for Amazon Bedrock

[TW](README.zh-tw.md) | [JA](README.ja.md)

Use Amazon Bedrock models in VS Code Chat with your AWS named profile (SSO supported). No API keys are used or stored, and usage or diagnostic data is not sent to the author. Chat requests go to Amazon Bedrock; usage totals, per-model thinking settings, and downloaded pricing data are stored in VS Code's local extension storage.

This extension uses only the Native ConverseStream API on the `bedrock-runtime` endpoint. It does not use the `bedrock-mantle` endpoint or the OpenAI-compatible Chat Completions/Responses or Anthropic Messages APIs available on `bedrock-runtime`.

## Features

- Loads available Bedrock models from your AWS account and supports geographic or global inference-profile routing.
- Filters eligible models by provider and model family, such as Anthropic (Claude), OpenAI (GPT and GPT-OSS), xAI (Grok), and NVIDIA (Nemotron). You can set minimum versions for Claude, regular GPT, and Grok; models with unknown versions remain visible and are marked when a minimum applies.
- Supports Chat Agent tool calling and image input for models that support it.
- Lets you set thinking effort per model. Unsupported settings may be adjusted by the extension or rejected by Bedrock.
- Lets you create additional Chat models with a fixed thinking effort for models with configurable thinking; the original model remains available. Preset names are generated from the base model's display name, effort, and fixed route, for example `Luna-Medium (Geo)`.
- Shows this period's input and output token totals in the status bar, with per-model request counts, tokens (including prompt cache reads and writes), and estimated costs in the usage panel. Reports each request's Bedrock token usage to VS Code for Chat Session Info/context window information, separately from period totals and without adding to Copilot credit totals.
- Uses Bedrock prompt caching for Claude models that support it, so repeated conversation context can be read from the cache.
- Lets you update the price table, set custom prices, and configure the monthly usage reset day and UTC hour. Usage totals, downloaded regional price tables, and model-card caches are shared only across Hosts that can access the same shared local storage (while usage remains grouped by AWS profile), and updates or scheduled resets automatically refresh the status bar and any open usage panel.

## Requirements

- VS Code 1.106 or later.
- AWS CLI v2 and a configured AWS profile. This extension uses AWS profiles only; it does not accept API keys or directly entered access keys.
- Amazon Bedrock enabled for your AWS account, with the selected model available in the configured region and inference scope.

## Getting Started

1. Configure an SSO profile with AWS CLI v2:
   ```powershell
   aws configure sso
   ```
2. Sign in to the profile:
   ```powershell
   aws sso login --profile <profile>
   ```
3. Set `amazonBedrockProvider.profile` in VS Code settings to the profile name, such as `bedrock`. Set `amazonBedrockProvider.region` if the profile does not specify a region.
4. Open the Chat model picker, select an Amazon Bedrock model, and start chatting.

## AWS Permissions

| Permission | Purpose | Required |
| --- | --- | --- |
| `bedrock:ListInferenceProfiles` | Get the list of models you can call | Yes |
| `bedrock:InvokeModelWithResponseStream` | Chat with models using streaming | Yes |
| `bedrock:ListFoundationModels` | Get model capabilities, such as image support | Recommended |

Without `bedrock:ListFoundationModels`, chat still works, with these differences:

- **Images**: For each model, the extension uses the first available source: built-in image test results, then the `inputModalities` reported by `bedrock:ListFoundationModels`. If neither is available, the model accepts image attachments, and if it does not support images, you see an error after sending. Models known not to support images do not receive images; the extension sends a text note instead. Images returned by agent tools, such as screenshots, follow the same rules.
- **Model list**: Only models whose IDs start with a prefix such as `us.` or `global.` are listed. Models that can be called only by their plain model ID, such as `openai.gpt-oss-20b-1:0`, do not appear.
- **When Model Visibility selects all providers**: Models that cannot chat, such as image generation and embedding models, also appear in the picker.

With the default Anthropic and OpenAI selection, the main difference is image support.

Some third-party Marketplace models also require `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe`, as well as a completed subscription for the model. Ask your AWS administrator to scope resource ARNs and conditions to your models, region, and organization policies.

To check the model list permissions, run these commands with your profile and region. They do not call a model and incur no charges.

```powershell
aws bedrock list-inference-profiles --profile <profile> --region <region>
aws bedrock list-foundation-models --profile <profile> --region <region>
```

If the first command fails, the model list cannot be loaded. If only the second command fails, chat still works with the differences listed above. These commands do not check `bedrock:InvokeModelWithResponseStream`; to confirm it, send a message in Chat.

## Settings

### Use the Command Palette (recommended)

Press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) to open the Command Palette and type `Bedrock` to find the commands below. For everyday use, you do not need to edit JSON or look up model IDs; the JSON examples below are for advanced configuration.

**Model Visibility: choose which models to show**

1. Run **Chat Model Provider for Amazon Bedrock: Configure Model Visibility**.
2. Choose **All providers**, or choose **Selected providers**, check the providers you want, and press Enter. Selecting no providers shows no models.
3. Follow the prompts to set minimum versions for Claude, GPT, or Grok, such as `4.6` or `6`; leave a field empty and press Enter for no minimum. Only families belonging to selected providers are prompted; All providers prompts for all three families.
4. Review the summary and choose **Save**, then open the Chat model picker to see the result. Pressing Esc to cancel during the process does not save changes.

**Model Presets: create models with a fixed thinking effort**

Presets are primarily intended for workflows that automatically invoke agents or sub-agents. When a workflow can select a model but cannot specify thinking effort separately, you can create presets of the same base model with different effort levels, allowing you or the agent assigning tasks to choose according to task difficulty. For example, use a `medium` preset for routine tasks and a `max` preset for more complex reasoning, without manually changing the original model's thinking setting before every run. The user or caller chooses the preset; the extension does not automatically assess task difficulty or switch presets, and the effort must still be supported by the model.

1. Open the Chat model picker once to load the currently available model list.
2. Press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS), run **Chat Model Provider for Amazon Bedrock: Manage Model Presets**, and choose **Add preset**.
3. Select the base model by its display name and check the route shown for that item (`Geo`, `Global`, or `In-Region`). Only models with configurable thinking are listed; you do not need to enter a model ID.
4. Choose the thinking effort, review the generated preset name, and choose **Save**. The model ID, UUID, and fixed route are written to settings automatically. Reopen the Chat model picker to select the new preset; the original model remains available.
5. To edit later, run **Manage Model Presets** again and select an existing preset. Choose **Change thinking effort** and save the new effort, or choose **Remove preset** and confirm removal. Cancelling does not save changes.

The preset menu edits User settings only. If a workspace override is active, it offers to open workspace Settings (JSON) instead of editing it directly. If no models are available when adding, check that the model list is loaded, visibility filtering allows the model, and the model supports configurable thinking.

### Settings and JSON examples

- **Model Visibility**: Use **Configure Model Visibility** or edit `amazonBedrockProvider.modelVisibility` in Settings (JSON). The default selects Anthropic and OpenAI with no minimum version. Provider groups show their model families, such as Anthropic (Claude), OpenAI (GPT, GPT-OSS, GPT-OSS Safeguard), xAI (Grok), and NVIDIA (Nemotron). In `all` mode, future providers are included; in `selected` mode, an empty `providers` array selects no providers. The menu asks for a minimum version only for the providers you select; saving removes thresholds for unselected providers. Existing Bedrock and Chat eligibility rules still apply.

  The legacy `amazonBedrockProvider.modelFilter` setting was removed in version 2.0.0. If it was set to `all`, set `amazonBedrockProvider.modelVisibility` to `{"mode":"all","providers":[]}` to retain the all-providers behavior. Otherwise, the default is Anthropic and OpenAI with no minimum version.

  Optional `minimumVersions` thresholds are inclusive and apply to Claude, regular GPT, and Grok. Setting a GPT threshold also hides GPT-OSS and Safeguard models. When a model's version cannot be interpreted, it remains visible and is marked as unknown, so a minimum version does not guarantee that every listed model meets that threshold. For example:

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

- **Model Presets**: Use **Manage Model Presets** to add a preset from a currently listed model and route, change its effort, remove it, or open Settings (JSON). The original model's settings are unchanged. The menu and JSON share `amazonBedrockProvider.modelPresets`. Each entry has an `id`, a foundation model `modelId`, a fixed `route` (`Geo`, `Global`, or `In-Region`), and an `effort` (`default`, `off`, `low`, `medium`, `high`, `xhigh`, or `max`). The menu generates a UUID for each new preset and generates the Chat display name from the base model name, effort, and route; the name is not stored or editable.

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

  A missing setting or an empty array means there are no presets. Workspace settings replace the User array completely; the menu edits User settings only and directs you to workspace Settings (JSON) when a workspace override is active. Duplicate IDs and duplicate model/route/effort combinations are rejected. A preset is listed only while its base model is available in the exact saved route and passes model visibility filtering. Changing the inference scope never reroutes a preset. If its model or route is temporarily unavailable, the preset is hidden but its setting is retained and it reappears when available again.

  A preset always uses its saved effort, independently of the base model's **Set Thinking Effort** value or **Reset All**. Unsupported effort values follow the existing request handling; defining a preset does not confirm that Bedrock accepts the effort.

- **Inference Scope**: `geo` uses a geographic inference profile and hides models that offer only a global profile. `global` prefers a global profile, which may route requests to AWS Regions worldwide, and falls back to the geographic profile when a model has no global profile.
- **Usage Reset Day / Hour**: Set the monthly reset day (1–31) and UTC hour (0–23). If a month does not have the selected day, usage resets on the month's last day. Changing the schedule does not immediately clear usage; it resets at the next reset time under the new schedule.
- **Custom Pricing**: Set USD prices per million tokens by model ID. Custom prices take precedence over the downloaded price table. `cacheRead` and `cacheWrite` are optional prompt cache prices; without them, costs for requests that read or write the prompt cache are not estimated. For example:

  ```json
  {
    "openai.gpt-6-astra": {
      "input": 5,
      "output": 20
    }
  }
  ```

- **Proxy URL**: Set the optional `amazonBedrockProvider.proxyUrl` (machine scope) to an `http://` or `https://` proxy URL. Only this extension uses it for Amazon Bedrock requests and public AWS price/model-card downloads. The extension does not read `HTTP_PROXY` or `HTTPS_PROXY`, and embedded credentials in the URL are not supported.

## Usage and Costs

Input and output token usage reported by Bedrock is accumulated by AWS profile, model, and inference route in a shared usage file in the Default Profile's VS Code extension `globalStorage` directory, so only Hosts that can access the same shared local storage contribute to the totals, which remain grouped by AWS profile. Each request's Bedrock input/output counts are also reported to VS Code for Chat Session Info/context window information; these are separate from period totals and do not affect Copilot credit totals. When the scheduled reset time arrives, the extension automatically refreshes the status bar and any open usage panel. Hosts that can access the same local path use the same JSON usage file; Node's built-in SQLite is used only to coordinate the write lock and does not store usage totals. If no shared local path is available, the lock times out, or the storage is unavailable, that usage record is skipped: it is not saved to the VS Code Profile or queued for later, so estimates may be lower. Skipping that record does not delete or move existing usage; scheduled and manual resets continue to work normally. This does not affect Chat responses, Session Info token reporting, or your AWS bill. The existing one-time migration of legacy usage from VS Code `globalState` remains; skipped new records are not migrated. Costs are estimates, not AWS billing data; actual charges are shown on your AWS bill. **Update Prices** downloads the public AWS price list and the price tables on AWS model cards into separate shared JSON files (`shared-prices.json` by region and `shared-model-cards.json`) in the same Default Profile `globalStorage` directory, each coordinated with its own SQLite write lock so a download in one VS Code Profile immediately updates other Hosts sharing that local path. If no shared local path is available, the lock times out, or writing fails, price and model-card downloads report an error and are not saved to the VS Code Profile; existing one-time migration of legacy `globalState` prices and model-card caches runs without overwriting newer shared data. Prices come from your custom prices first, then the price list, then the model cards, so GPT models missing from the price list are still estimated; the cost column marks model card prices with **model card**. Models without any of these prices show **No price data**.

Preset requests are recorded and priced under the underlying model and route, so they are grouped with usage from the original model on that route. The selected effort can affect the token counts reported by Bedrock; it does not add a separate price or change the cost-estimation rules.

Some GPT models charge long-context prices for the whole request when its input exceeds 272K tokens (as stated on their model cards), and Claude Haiku 5.5 does the same above 100K tokens (as stated on Anthropic's pricing page; the AWS model card gives no threshold). The extension classifies each request when it is recorded, counting cache reads and writes as input, and prices those requests with the long-context rates. Usage recorded before this version is priced at standard rates. Custom prices have no long-context tier, so a model with long-context requests and only custom prices shows **No long-context price**.

For Claude models listed as supporting prompt caching in the [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), the extension adds cache points after the tool definitions, the system prompt, and the latest message. Other models, such as GPT, may still report cache reads or writes on their own. In the usage panel, **Input tokens** is split into **Input** (uncached), **Cache read**, and **Cache write**; the three add up to the total input, which the status bar shows. Cache reads and writes are priced separately. Cache prices come from the price list or the model cards (GPT cache writes use the 30-minute rate); if you downloaded prices with an earlier version, select **Update Prices** again. When a model has cache tokens but no cache price, its cost shows **No cache price** and is excluded from the total.

The status bar shows this period's input and output tokens. Select the token totals to open the usage panel, where you can update prices, open custom pricing settings, or reset usage.

## Security and Privacy

### Data Use and Network Access

This extension does not send usage, diagnostic, or analytics data to the author. Usage totals are stored locally in VS Code, and diagnostic logs are available locally for troubleshooting. Chat content is sent to Amazon Bedrock as described below. The extension makes these network requests:

1. Amazon Bedrock in the selected region, through your AWS profile (loading the model list and streaming chat). The extension uses the SDK's default HTTPS endpoints for Bedrock and ignores custom Bedrock endpoint overrides from AWS configuration files and environment variables.
2. An HTTPS GET request to the public AWS price file when you select **Update Prices**. The request contains no account information or credentials.
3. HTTPS GET requests to public AWS model card pages (docs.aws.amazon.com) to read context windows, maximum output tokens, and prices: in the background when your model list includes a model missing from the built-in list (cached for 7 days), and for every model card when you select **Update Prices**. The requests contain no account information or credentials.

Public downloads follow redirects only within the original HTTPS origin. The size limit applies both before and after decompression: 64 MiB for the price file and 8 MiB per model card or index.

If `amazonBedrockProvider.proxyUrl` is set, only this extension uses that `http://` or `https://` proxy for the requests above and leaves `HTTP_PROXY` and `HTTPS_PROXY` environment variables unread. Embedded credentials in the proxy URL are not supported. TLS certificates must be trusted for both an HTTPS proxy and the destination server. Disabling certificate verification in the Node.js environment does not make this extension skip TLS verification.

When you select the sign-in button, the extension starts AWS CLI `aws sso login` locally, and AWS CLI opens your browser to complete sign-in (for example, to choose an account and approve access). The extension never starts sign-in automatically in the background.

VS Code's own usage and diagnostic data sharing follows the VS Code `telemetry.telemetryLevel` setting and is not controlled by this extension.

### Credentials

- Bedrock requests use SigV4 with the AWS named profile you specify. API keys (including `AWS_BEARER_TOKEN_BEDROCK`) and directly entered access keys are not accepted.
- If the selected profile uses `credential_process`, the AWS SDK may run the configured local command when it loads the model list, without waiting for you to select **Sign in**. Choose a profile whose configuration and credential command you trust.
- The AWS SDK resolves credentials through the profile for every request. The extension never stores access keys, secret keys, session tokens, or SSO tokens in VS Code settings, `globalState`, or logs.
- AWS CLI handles SSO sign-in. The AWS SDK reads `~/.aws/config` and `~/.aws/credentials` to resolve the profile, and may refresh an SSO token that is about to expire in `~/.aws/sso/cache/`, as AWS CLI does. The extension does not modify any other AWS files.

### Your Conversations

- Chat messages, tool results, and attachments are sent only to Amazon Bedrock in your own AWS account, governed by your IAM permissions, your AWS bill, and the AWS terms.
- According to AWS documentation, model providers have no access to Amazon Bedrock customer prompts and completions. See [Amazon Bedrock Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html).
- With the `global` inference scope, requests may be routed to AWS regions worldwide. Use `geo` if you have data residency requirements.
- For Claude models that support prompt caching, Bedrock keeps the cached prompt prefix for 5 minutes (the default TTL) so later requests can reuse it.

### Local Storage

- A shared usage file in the Default Profile's extension `globalStorage` directory stores usage totals (profile name, model ID, token and request counts). Hosts that can access the same shared local storage accumulate usage in this file, while totals remain grouped by AWS profile. Scheduled resets automatically refresh the status bar and any open usage panel.
- VS Code `globalState` stores per-model thinking settings, downloaded price tables, and token limits and prices read from AWS model cards. This data is not synced to other devices. Reset thinking settings with **Set Thinking Effort**; downloaded price tables are replaced when you select **Update Prices**.
- The extension does not write chat content to local storage or logs.

### Logs

- **Show Logs** records only diagnostics such as profile name, region, model ID, message counts, tool names, and error codes, never chat content. AWS principal ARNs and email addresses in error messages are redacted.
- The extension redacts URL parameters, the organization name in the Start URL, email addresses, and one-time device authorization codes before recording AWS CLI sign-in output. Still review logs for personal information before sharing. If the browser does not open during sign-in, run `aws sso login --profile <profile>` in a terminal.

### Open Source

The source code is available on [GitHub](https://github.com/omoshiRoyQ/chat-model-provider-for-amazon-bedrock) under the MIT license, so you can review or build it yourself. Report security issues privately through the repository's GitHub Security page, and never post credentials or logs in public issues.

## Troubleshooting

- **No AWS Region is configured**: Set `amazonBedrockProvider.region` in VS Code settings or configure a region in your AWS profile.
- **Model list permissions are missing**: Ask your administrator to grant `bedrock:ListInferenceProfiles`.
- **Model invocation is denied**: Check that the profile has `bedrock:InvokeModelWithResponseStream` and that the model is available in the selected region and inference scope. Marketplace models may also require subscription permissions.
- **SSO sign-in has expired**: Select the Bedrock sign-in button or run `aws sso login --profile <profile>`, then resend the failed Chat request.
- **A configured network path is not being used**: Check that `amazonBedrockProvider.proxyUrl` is an `http://` or `https://` URL without embedded credentials. This extension does not read `HTTP_PROXY` or `HTTPS_PROXY`.
- **Detailed diagnostics**: Run **Show Logs** from the Command Palette. Redact personal information and verification details before sharing logs.

## Build a VSIX

Run `pnpm run package:verified` to run all unit tests, then package the extension and list the package contents. Packaging automatically runs `vscode:prepublish` for type checking, license and localization checks, and the production build. Each prerequisite runs once; a failure stops subsequent steps. The VSIX is written to `.tmp/chat-model-provider-for-amazon-bedrock-<version>.vsix`.

`pnpm run verify` runs the full checks without generating a VSIX. `pnpm run package` remains the packaging-only entry point with automatic prepublish checks; it does not run unit tests. Security review, release audit, and testing the installed VSIX remain separate. These scripts do not install or publish the extension or call Bedrock models. If a run fails, do not mistake an older VSIX for a new build.

## License

This project is licensed under MIT; see [LICENSE](LICENSE). Licenses and copyright notices for bundled dependencies are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

This project is maintained solely by its author, who does not accept external pull requests. Issue reports are welcome, as are forks under the MIT license, provided this project is credited as the source and the required copyright and license notice is preserved.

Amazon Bedrock and AWS are trademarks of Amazon.com, Inc. or its affiliates. This independent project is not affiliated with, endorsed by, or sponsored by Amazon.com, Inc. or AWS.