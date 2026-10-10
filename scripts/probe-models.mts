// Developer check: probes tool and image support of the models listed for an AWS profile with ConverseStream requests capped
// at maxTokens=16 (billed), skipping models probed as tools=false, already having an image result, or marked unsupported. It prints lines to paste
// and writes the same text to .project/probe-models-results.txt (overwritten each run); it writes only that result file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseStreamCommand, type ContentBlock, type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { PROBED_CAPABILITIES, resolveModels, type FoundationSummary, type ProfileSummary } from '../src/models.ts';

// Every line printed to the terminal is also kept here so the result file holds the same text.
const output: string[] = [];
const PROJECT_DIR = new URL('../.project/', import.meta.url);
const RESULT_FILE = new URL('probe-models-results.txt', PROJECT_DIR);

function say(line = '', stream: (text: string) => void = console.log): void {
    output.push(line);
    stream(line);
}

function saveResults(): void {
    mkdirSync(PROJECT_DIR, { recursive: true }); // Create .project/ on a fresh clone so paid results are not lost at the end.
    writeFileSync(RESULT_FILE, `${output.join('\n')}\n`, 'utf8');
}

const { values: args } = parseArgs({ options: { profile: { type: 'string' }, region: { type: 'string' }, scope: { type: 'string', default: 'geo' } } });
if (!args.profile || !args.region || (args.scope !== 'geo' && args.scope !== 'global')) {
    console.error('用法：pnpm run probe-models --profile <name> --region <region> [--scope geo|global]');
    process.exit(1);
}
const credentials = fromIni({ profile: args.profile });

const profiles: ProfileSummary[] = [];
let foundations: FoundationSummary[] = [];
const control = new BedrockClient({ region: args.region, credentials });
try {
    let nextToken: string | undefined;
    do {
        const page = await control.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken }));
        profiles.push(...(page.inferenceProfileSummaries ?? []).flatMap((p) => (p.inferenceProfileId
            ? [{ id: p.inferenceProfileId, name: p.inferenceProfileName ?? p.inferenceProfileId, active: p.status === 'ACTIVE' }]
            : [])));
        nextToken = page.nextToken;
    } while (nextToken);
    foundations = ((await control.send(new ListFoundationModelsCommand({}))).modelSummaries ?? []).flatMap((m) => (m.modelId ? [{
        id: m.modelId,
        name: m.modelName ?? m.modelId,
        textOutput: m.outputModalities?.includes('TEXT') ?? false,
        streaming: m.responseStreamingSupported ?? false,
        onDemand: m.inferenceTypesSupported?.includes('ON_DEMAND') ?? false,
        imageInput: m.inputModalities?.includes('IMAGE') ?? false,
    }] : []));
} catch (error) {
    say(`無法列出模型：${(error as Error).name}: ${(error as Error).message}\nSSO 過期時請先執行 aws sso login --profile ${args.profile}`, console.error);
    saveResults();
    process.exit(1);
} finally {
    control.destroy();
}

// Same list the extension shows with Model Filter set to all models. Skips three kinds: tools=false, an image result, and
// unsupported (retired or noConverse). Models with only a tools result stay in the list so the image test can fill in.
// resolveModels gets an empty probe table so the unsupported models are still in the list here and are removed by this filter.
const targets = resolveModels(profiles, foundations, args.scope, false, new Map(), {}).models
    .filter((m) => {
        const probed = PROBED_CAPABILITIES[m.baseId];
        return probed?.tools !== false && probed?.image === undefined && probed?.unsupported === undefined;
    });
say(`待測 ${targets.length} 個模型（略過三種：tools=false、已有圖片結果、unsupported）；每個模型最多 3 次請求，maxTokens=16。`);

const runtime = new BedrockRuntimeClient({ region: args.region, credentials });
const TOOLS: ToolConfiguration = { tools: [{ toolSpec: { name: 'ping', description: 'Returns pong.', inputSchema: { json: { type: 'object', properties: {} } } } }] };
const PNG_64X64 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAcElEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3M7QGp3PDiCKMcygAAAABJRU5ErkJggg==', 'base64');

/** Returns undefined on success, otherwise the AWS error name and message. */
async function attempt(modelId: string, content: ContentBlock[], toolConfig?: ToolConfiguration): Promise<{ name: string; message: string } | undefined> {
    try {
        const response = await runtime.send(new ConverseStreamCommand({
            modelId,
            messages: [{ role: 'user', content }],
            inferenceConfig: { maxTokens: 16 },
            toolConfig,
        }));
        for await (const _event of response.stream ?? []) {
            // Drain the stream so errors raised mid-stream are caught.
        }
        return undefined;
    } catch (error) {
        const e = error as { name?: string; message?: string };
        return { name: e.name ?? 'Error', message: e.message ?? '' };
    }
}

const lines: string[] = [];
const undetermined: string[] = [];
for (const model of targets) {
    const text: ContentBlock = { text: 'Hi' };
    const baseline = await attempt(model.invokeId, [text]);
    if (baseline) {
        undetermined.push(`${model.baseId}（${model.invokeId}）：不帶工具與圖片也失敗，${baseline.name}: ${baseline.message}`);
        continue;
    }
    // Only ValidationException means the feature was rejected; other errors (throttling, access) leave it undetermined.
    // A model already probed tools=true skips the tools request and goes straight to the image test.
    const tool = PROBED_CAPABILITIES[model.baseId]?.tools === true ? undefined : await attempt(model.invokeId, [text], TOOLS);
    if (tool && tool.name !== 'ValidationException') {
        undetermined.push(`${model.baseId}（${model.invokeId}）：工具測試 ${tool.name}: ${tool.message}`);
        continue;
    }
    if (tool) {
        lines.push(`'${model.baseId}': { tools: false }, // ${tool.message}`);
        continue;
    }
    const image = await attempt(model.invokeId, [text, { image: { format: 'png', source: { bytes: PNG_64X64 } } }]);
    if (image && image.name !== 'ValidationException') {
        // Image undetermined: omit the image field so inputModalities applies; the tools result is still valid.
        lines.push(`'${model.baseId}': { tools: true }, // image undetermined: ${image.name}: ${image.message}`);
        continue;
    }
    lines.push(`'${model.baseId}': { tools: true, image: ${!image} },${image ? ` // ${image.message}` : ''}`);
}
runtime.destroy();

say();
say('貼進 src/models.ts 的 PROBED_CAPABILITIES：');
say(`    // Probed ${new Date().toLocaleDateString('sv-SE')} with ConverseStream (${args.region}, maxTokens=16)`);
for (const line of lines) {
    say(`    ${line}`);
}
if (undetermined.length > 0) {
    say();
    say('無法判斷（不要貼進去；排除原因後重跑）：');
    for (const line of undetermined) {
        say(`  ${line}`);
    }
}
saveResults();
