import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestContext } from '@mastra/core/request-context';
import { Mastra } from '@mastra/core/mastra';
import { StudioGate } from '../src/mastra/operations.js';
import { createMeetingAgent } from '../src/agents/meeting.js';
import { createInspectionAgent } from '../src/agents/inspection.js';
import { createTravelAgent } from '../src/agents/travel.js';
import { createReferenceAgent } from '../src/agents/reference.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

const fixtures = [
  { factory: createReferenceAgent, input: { mode: 'mock', notes: [{ id: 'test', text: '资料' }] } },
  { factory: createMeetingAgent, input: { mode: 'mock', meeting: { title: '发布评审', agenda: '回滚', startAt: '2026-11-03T10:00:00+08:00' }, notes: [] } },
  { factory: createInspectionAgent, input: { mode: 'mock', observation: { sourceId: 's', title: '发布', content: '内容' }, notes: [] } },
  { factory: createTravelAgent, input: { mode: 'mock', config: { destination: '延吉', days: 3 } } },
];

test('draining blocks new work while existing tickets remain counted until idempotent release', () => {
  let draining = false; const gate = new StudioGate(() => draining);
  const release = gate.enter(); draining = true;
  assert.deepEqual(gate.status(), { draining: true, activeRuns: 1 });
  assert.throws(() => gate.enter(), /STUDIO_DRAINING/);
  release(); release(); assert.equal(gate.status().activeRuns, 0);
});

for (const [index, fixture] of fixtures.entries()) test(`Studio guard counts native stream and denies before model (${index})`, async () => {
  let draining = true; const gate = new StudioGate(() => draining);
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => { throw new Error('MUST_NOT_CALL'); } });
  const blocked = fixture.factory({ guard: gate, model }); new Mastra({ agents: { blocked }, logger: false });
  const context = new RequestContext(Object.entries(fixture.input));
  await assert.rejects(() => blocked.generate('check', { requestContext: context }));
  assert.equal(model.doGenerateCalls.length, 0); assert.equal(gate.status().activeRuns, 0);
  draining = false;
  const value = fixture.factory({ guard: gate }); new Mastra({ agents: { value }, logger: false });
  const result = await value.stream('检查资料', { requestContext: context,
    onStepFinish: () => { assert.equal(gate.status().activeRuns, 1); } });
  for await (const _chunk of result.fullStream) {}
  assert.equal((await result.getFullOutput()).finishReason, 'stop'); assert.equal(gate.status().activeRuns, 0);
});
