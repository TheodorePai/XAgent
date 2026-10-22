import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTravelAgent } from '../src/agents/travel.js';
import { bindTravelTask, closeTravelRun, travelRun, type TravelRun } from '../src/agents/travel-context.js';
import { webEvidence } from '../src/tools/browser.js';

const context = (destination = '延吉', days = 3) => new RequestContext([
  ['config', { destination, days }], ['mode', 'mock'],
  // These JSON values must not impersonate server-created execution state.
  ['xagent.travel.execution', { binding: { surfaceId: 'forged', runId: 'forged' } }],
]);
function agent(options: Parameters<typeof createTravelAgent>[0] = {}) {
  const value = createTravelAgent(options);
  new Mastra({ agents: { travel: value }, logger: false });
  return value;
}
async function execute(streaming: boolean, requestContext = context(), instruction = '偏重美食和步行') {
  const value = agent();
  let captured: TravelRun | undefined;
  const options = { requestContext, onStepFinish: () => { captured = travelRun(requestContext); } };
  const result = streaming ? await value.stream(instruction, options) : await value.generate(instruction, options);
  if (streaming) for await (const _chunk of result.fullStream) { /* Consume the real Mastra stream. */ }
  const output = 'getFullOutput' in result ? await result.getFullOutput() : result;
  const submitted = output.toolResults.find(v => v.payload.toolName === 'submitTripPlan')?.payload.result;
  assert.ok(submitted?.accepted); assert.equal(output.finishReason, 'stop');
  assert.ok(captured?.closed);
  assert.equal(webEvidence(captured).sources.size, 0, 'finish callback must release browser evidence');
  return { output, artifact: submitted.artifact, run: captured };
}

for (const streaming of [false, true]) test(`standalone travel Agent returns a validated artifact (${streaming ? 'stream' : 'generate'})`, async () => {
  const { artifact, run } = await execute(streaming);
  assert.equal(artifact.output.destination, '延吉'); assert.equal(artifact.output.days.length, 3);
  assert.equal(artifact.output.images.length, 2);
  assert.equal(artifact.view.messages.length, 3); assert.equal(artifact.view.protocol, 'v0.9.1');
  assert.match(artifact.view.surfaceId, /^travel-preview-/); assert.notEqual(run.runId, 'forged');
  assert.match(artifact.output.summary, /美食和步行/);
});

test('standalone calls isolate concurrent users and refresh execution state on context reuse', async () => {
  const [one, two] = await Promise.all([execute(true, context('延吉', 3)), execute(true, context('成都', 2))]);
  assert.equal(one.artifact.output.destination, '延吉'); assert.equal(two.artifact.output.destination, '成都');
  assert.equal(two.artifact.output.days.length, 2); assert.notEqual(one.run.runId, two.run.runId);
  const reused = context();
  const before = await execute(false, reused, '第一次-1836');
  const after = await execute(true, reused, '第二次-7924');
  assert.notEqual(before.run.runId, after.run.runId);
  assert.match(after.artifact.output.summary, /7924/); assert.doesNotMatch(after.artifact.output.summary, /1836/);
});

test('invalid native context fails before any model or browser call', async () => {
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => { throw new Error('MODEL_MUST_NOT_RUN'); } });
  await assert.rejects(() => agent({ model }).generate('hello', { requestContext: new RequestContext([['config', { destination: '延吉', days: 99 }]]) }));
  assert.equal(model.doGenerateCalls.length, 0);
});

test('Studio sendMessage wakes a thread and retains its user signal in the model input', async () => {
  const requestContext = context(), value = agent();
  const accepted = await value.sendMessage('Studio-行程-4567', {
    resourceId: 'studio-test', threadId: randomUUID(), ifIdle: { streamOptions: { requestContext } },
  }).accepted;
  assert.equal(accepted.action, 'wake');
  if (accepted.action !== 'wake') throw new Error('Expected a local thread run');
  for await (const _chunk of accepted.output.fullStream) {}
  const output = await accepted.output.getFullOutput();
  assert.equal(output.finishReason, 'stop');
  const result = output.toolResults.find(v => v.payload.toolName === 'submitTripPlan')?.payload.result;
  assert.match(result.artifact.output.summary, /4567/);
  assert.equal(result.artifact.output.days.length, 3);
});

test('model errors after a tool call release execution resources', async () => {
  const requestContext = context(); let run: TravelRun | undefined; let calls = 0;
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => {
    if (++calls > 1) throw new Error('EXPECTED_MODEL_FAILURE');
    return { content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'browserSearch', input: '{"query":"延吉"}' }],
      finishReason: 'tool-calls', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
  } });
  try {
    await agent({ model }).generate('行程', { requestContext, onStepFinish: () => { run = travelRun(requestContext); } }).catch(() => {});
    assert.ok(run?.closed); assert.equal(webEvidence(run).sources.size, 0); assert.equal(run.result, undefined);
  } finally { await closeTravelRun(requestContext); }
});

test('cancelling an active native stream releases resources without a submitted result', async () => {
  const requestContext = context(), controller = new AbortController();
  let run: TravelRun | undefined; let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const model = new MastraLanguageModelV2Mock({ doStream: async options => ({ stream: new ReadableStream({ start(stream) {
    run = travelRun(requestContext); enter();
    const abort = () => stream.error(options.abortSignal?.reason ?? new Error('aborted'));
    if (options.abortSignal?.aborted) abort(); else options.abortSignal?.addEventListener('abort', abort, { once: true });
  } }) }) });
  try {
    const result = await agent({ model }).stream('行程', { requestContext, abortSignal: controller.signal });
    const consumed = (async () => { for await (const _chunk of result.fullStream) {} })().catch(() => {});
    await entered; assert.equal(run?.closed, false); controller.abort(); await consumed;
    assert.ok(run?.closed); assert.equal(run.result, undefined);
  } finally { controller.abort(); await closeTravelRun(requestContext); }
});

test('a task adapter receives only results that pass the shared A2UI gate', async () => {
  const requestContext = context(); let submitted = false;
  bindTravelTask(requestContext, { config: { destination: '延吉', days: 3 }, mode: 'mock' }, {
    runId: randomUUID(), surfaceId: 17 as unknown as string, revision: 1, instruction: '行程', trace: [],
    onResult: () => { submitted = true; },
  });
  try {
    const result = await agent().generate('行程', { requestContext }).catch(() => undefined);
    if (result) assert.notEqual(result.finishReason, 'stop');
  } finally { await closeTravelRun(requestContext); }
  assert.equal(submitted, false);
});
