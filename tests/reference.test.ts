import test from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createReferenceAgent } from '../src/agents/reference.js';
import { scriptedModel } from '../src/tasks/fixture.js';

function setup(options: Parameters<typeof createReferenceAgent>[0] = {}) {
  const value = createReferenceAgent(options); new Mastra({ agents: { value }, logger: false }); return value;
}
const input = { mode: 'mock', notes: [{ id: 'reference-101', text: '负责人林舟，保留15秒超时限制。' }] };
test('minimal Agent template executes generate and Studio signal paths with a checked artifact', async () => {
  const agent = setup();
  const result = await agent.generate('关注负责人 TEMPLATE-101', { requestContext: new RequestContext(Object.entries(input)) });
  const accepted = result.toolResults.find(t => t.payload.toolName === 'submitSummary')!.payload.result;
  assert.equal(accepted.accepted, true); assert.equal(accepted.artifact.view.messages.length, 3);
  assert.deepEqual(accepted.artifact.output.sourceIds, ['reference-101']); assert.match(result.text, /TEMPLATE-101/);
  const wake = await agent.sendMessage('关注超时 TEMPLATE-102', { threadId: 'template-test', resourceId: 'test',
    ifIdle: { streamOptions: { requestContext: new RequestContext(Object.entries(input)) } } }).accepted;
  assert.equal(wake.action, 'wake'); if (wake.action !== 'wake') throw new Error('Expected wake');
  for await (const _chunk of wake.output.fullStream) {}
  assert.match((await wake.output.getFullOutput()).text, /TEMPLATE-102/);
});
test('template refuses missing references before calling the model', async () => {
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => { throw new Error('MUST_NOT_CALL'); } });
  await assert.rejects(() => setup({ model }).generate('test', { requestContext: new RequestContext([['mode', 'mock']]) }));
  assert.equal(model.doGenerateCalls.length, 0);
});
test('template rejects fabricated sources rather than publishing an artifact', async () => {
  const model = scriptedModel('bad-reference', (_input, results) => {
    if (!results.has('searchReferenceNotes')) return { tool: 'searchReferenceNotes', args: { query: 'test' } };
    return { tool: 'submitSummary', args: { summary: 'bad', sourceIds: ['foreign-reference'] } };
  });
  const output = await setup({ model }).generate('test', { requestContext: new RequestContext(Object.entries(input)), maxSteps: 2 }).catch(() => undefined);
  assert.notEqual(output?.finishReason, 'stop');
  assert.ok(!output?.toolResults.some(t => t.payload.toolName === 'submitSummary' && t.payload.result?.accepted));
});
