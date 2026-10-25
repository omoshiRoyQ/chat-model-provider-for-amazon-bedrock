// Developer check: probes tool and image support of the models listed for an AWS profile with ConverseStream requests capped
// at maxTokens=16 (billed), skipping models probed as tools=false, already having an image result, or marked unsupported. It prints lines to paste
// and writes the same text to .tmp/probe-models-results.txt (overwritten each run); it writes only that result file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BedrockRuntimeClient, ConverseStreamCommand, type ContentBlock, type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { fetchModelSources } from '../src/modelList.ts';
import { PROBED_CAPABILITIES, resolveModels, type FoundationSummary, type ProfileSummary } from '../src/models.ts';

// Every line printed to the terminal is also kept here so the result file holds the same text.
const output: string[] = [];
const RESULTS_DIR = new URL('../.tmp/', import.meta.url);
const RESULT_FILE = new URL('probe-models-results.txt', RESULTS_DIR);

function say(line = '', stream: (text: string) => void = console.log): void {
    output.push(line);
    stream(line);
}

function saveResults(): void {
    mkdirSync(RESULTS_DIR, { recursive: true }); // Keep paid results separate from disposable task checkpoints.
    writeFileSync(RESULT_FILE, `${output.join('\n')}\n`, 'utf8');
}

const { values: args } = parseArgs({ options: { profile: { type: 'string' }, region: { type: 'string' }, scope: { type: 'string', default: 'geo' } } });
if (!args.profile || !args.region || (args.scope !== 'geo' && args.scope !== 'global')) {
    console.error('Usage: pnpm run probe-models --profile <name> --region <region> [--scope geo|global]');
    process.exit(1);
}
const credentials = fromIni({ profile: args.profile });

let profiles: ProfileSummary[];
let foundations: FoundationSummary[];
try {
    const sources = await fetchModelSources(args.profile, args.region, { onFoundationModelsAccessDenied: 'throw' });
    profiles = sources.profiles;
    foundations = sources.foundations;
} catch (error) {
    say(`Cannot list models: ${(error as Error).name}: ${(error as Error).message}\nIf SSO has expired, run aws sso login --profile ${args.profile}`, console.error);
    saveResults();
    process.exit(1);
}

// Explicitly all providers/no minimum version, independent of VS Code visibility settings. Skips tools=false, an image result, and
// unsupported (retired or noConverse). Models with only a tools result stay in the list so the image test can fill in.
// resolveModels gets an empty probe table so the unsupported models are still in the list here and are removed by this filter.
const targets = resolveModels(profiles, foundations, args.scope, false, new Map(), {}, () => true).models
    .filter((m) => {
        const probed = PROBED_CAPABILITIES[m.baseId];
        return probed?.tools !== false && probed?.image === undefined && probed?.unsupported === undefined;
    });
say(`Probing ${targets.length} models (skipping tools=false, existing image results, and unsupported); at most 3 requests per model, maxTokens=16.`);

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
        undetermined.push(`${model.baseId} (${model.invokeId}): failed even without tools or images, ${baseline.name}: ${baseline.message}`);
        continue;
    }
    // Only ValidationException means the feature was rejected; other errors (throttling, access) leave it undetermined.
    // A model already probed tools=true skips the tools request and goes straight to the image test.
    const tool = PROBED_CAPABILITIES[model.baseId]?.tools === true ? undefined : await attempt(model.invokeId, [text], TOOLS);
    if (tool && tool.name !== 'ValidationException') {
        undetermined.push(`${model.baseId} (${model.invokeId}): tool test ${tool.name}: ${tool.message}`);
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
say('Paste into PROBED_CAPABILITIES in src/models.ts:');
say(`    // Probed ${new Date().toLocaleDateString('sv-SE')} with ConverseStream (${args.region}, maxTokens=16)`);
for (const line of lines) {
    say(`    ${line}`);
}
if (undetermined.length > 0) {
    say();
    say('Undetermined (do not paste; fix the cause and rerun):');
    for (const line of undetermined) {
        say(`  ${line}`);
    }
}
saveResults();
