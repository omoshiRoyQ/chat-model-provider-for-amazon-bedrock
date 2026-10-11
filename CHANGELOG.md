# Changelog

[TW](CHANGELOG.zh-tw.md) | [JP](CHANGELOG.ja.md)

## 1.4.1 (2026-10-11)

- The Sign in button in the status bar no longer disappears while the AWS SSO token is still expired. It was hidden whenever VS Code re-read the cached model list; now it is hidden only after a request to AWS succeeds or you sign in.

## 1.4.0 (2026-10-10)

- Requests now send the maximum output tokens published in the built-in list or the AWS model card, even when thinking effort is Default. Long responses from models such as Claude Haiku 5.5 were previously cut off at 4,096 tokens. Models without a published limit still send no maximum.
- When a response stops because it reached the maximum output tokens, the log now records a warning with the model ID and the maximum.
- Downloading the price table now times out after 60 seconds instead of waiting indefinitely.
- Models that a live test showed do not support tools are no longer listed.
- Image input support now uses live test results first, then the AWS input modalities.
- Known `stateful_marker` entries in chat history are skipped without logging a warning.

## 1.3.0 (2026-10-09)

- Added Claude Haiku 5.5 to the built-in list. Requests whose input exceeds 100K tokens, counting cache reads and writes, are priced at its long-context rates for the whole request, as stated on Anthropic's pricing page. Only usage recorded from this version on is classified.

## 1.2.1 (2026-10-06)

- Estimated costs in the usage panel now show whether the price came from custom settings, an AWS price table, or a model card.

## 1.2.0 (2026-10-04)

- Claude models listed as supporting prompt caching in the [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) now use Bedrock prompt caching: cache points are added after the tool definitions, the system prompt, and the latest message, with the default 5-minute TTL.
- Usage totals now include prompt cache reads and writes. The usage panel groups input into **Input** (uncached), **Cache read**, and **Cache write** columns under **Input tokens**; they add up to the total input, and the status bar input count now includes cache tokens.
- Cost estimates price cache reads and writes separately, using the cache prices in the AWS price table. Select **Update Prices** again to download them. Custom pricing accepts optional `cacheRead` and `cacheWrite` prices. A model with cache tokens but no cache price shows **No cache price** instead of an estimate.
- **Update Prices** also reads the price tables on AWS model cards, so models missing from the AWS price list but priced on their model card, such as most GPT models, now get cost estimates. Prices from model cards are marked **model card**, and are used only when neither custom prices nor the price list have the model.
- GPT long-context pricing: requests whose input exceeds 272K tokens, counting cache reads and writes, are priced at the long-context rates for the whole request, as stated on the model cards. Only usage recorded from this version on is classified.
- GPT-6 Astra's 30-minute cache write price in the AWS price list is now used.
- Added GPT-6.1 Sol to the built-in list. Its reasoning effort cannot be `none`, so **Off** uses low effort.

## 1.1.1 (2026-10-02)

- AWS CLI sign-in output in the logs now hides URL parameters, the organization name in the Start URL, and email addresses. If the browser does not open during sign-in, run `aws sso login --profile <profile>` in a terminal.

## 1.1.0 (2026-10-01)

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

## 1.0.0 (2026-09-29)

First release.

- Use Amazon Bedrock models in VS Code Chat through an AWS named profile (AWS IAM Identity Center / SSO supported), using only the `bedrock-runtime` Native ConverseStream API.
- Load available models from your AWS account, with geo or global inference profile routing and a Claude/GPT-only or all-models filter.
- Agent tool calling and image input for models that support them.
- Per-model thinking effort.
- The status bar shows this period's input and output tokens; the usage panel shows per-model request counts, tokens, and cost estimates, with price table updates, custom pricing, and a monthly reset schedule.
- Sign-in button for expired SSO sessions; `aws sso login` runs only when you select it.
- No telemetry, and no analytics data is sent to the author.
