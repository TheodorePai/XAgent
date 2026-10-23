import test from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createMeetingAgent, meetingDefinition } from '../src/agents/meeting.js';
import { createMeetingBriefWorkflow } from '../src/workflows/meeting-brief.js';
import { StudioGate } from '../src/mastra/operations.js';
import { WorkflowLifecycle } from '../src/workflows/lifecycle.js';

const input = { mode: 'mock' as const, instruction: 'CHECK-WF-731 核对超时与回滚',
  meeting: { title: '发布评审', agenda: '回滚准备', startAt: '2026-11-03T10:00:00+08:00' },
  notes: [{ id: 'release-042', text: '负责人林舟；超时15秒停止；准备回滚开关。' }] };
function setup(options: Parameters<typeof createMeetingBriefWorkflow>[0] = {}) {
  const workflow = createMeetingBriefWorkflow(options);
  new Mastra({ workflows: { workflow }, logger: false }); return workflow;
}

test('native Workflow runs all three steps and returns validated Agent artifact', async () => {
  const workflow = setup(), run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  assert.equal(result.status, 'success'); if (result.status !== 'success') throw new Error('Workflow failed');
  for (const step of ['prepare-meeting', 'draft-with-agent', 'validate-brief']) assert.equal(result.steps[step].status, 'success');
  assert.equal(result.result.accepted, true); assert.equal(result.result.artifact.view.messages.length, 3);
  assert.deepEqual(result.result.artifact.output.sourceIds, ['release-042']);
  assert.match(result.result.text, /CHECK-WF-731/);
});

test('native Workflow streaming produces the same result and releases its admission ticket', async () => {
  const guard = new StudioGate(() => false), workflow = setup({ guard }), run = await workflow.createRun();
  const stream = run.stream({ inputData: input });
  for await (const _chunk of stream.fullStream) {}
  const result = await stream.result;
  assert.equal(result.status, 'success'); assert.equal(guard.status().activeRuns, 0);
});

test('invalid input and duplicate references fail before any model calls', async () => {
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => { throw new Error('MUST_NOT_CALL'); } });
  const guard = new StudioGate(() => false), workflow = setup({ agent: createMeetingAgent({ model }), guard });
  const invalid = await workflow.createRun();
  await assert.rejects(() => invalid.start({ inputData: { ...input, instruction: '' } }));
  const duplicate = await workflow.createRun();
  const result = await duplicate.start({ inputData: { ...input, notes: [input.notes[0], input.notes[0]] } });
  assert.equal(result.status, 'failed'); assert.equal(model.doGenerateCalls.length, 0); assert.equal(guard.status().activeRuns, 0);
});

test('drain rejects new Workflow runs while admitted runs can finish with a stateless Agent', async () => {
  let draining = false, checked = false;
  const guard = new StudioGate(() => draining), model = meetingDefinition.fixture();
  const original = model.doGenerate.bind(model);
  model.doGenerate = async params => { assert.equal(guard.status().activeRuns, 1); draining = true; checked = true; return original(params); };
  const workflow = setup({ agent: createMeetingAgent({ model }), guard });
  const result = await (await workflow.createRun()).start({ inputData: input });
  assert.equal(result.status, 'success'); assert.ok(checked); assert.equal(guard.status().activeRuns, 0);
  await assert.rejects(async () => (await workflow.createRun()).start({ inputData: input }), /STUDIO_DRAINING/);
  assert.equal(guard.status().activeRuns, 0);
});

test('Agent failure terminates Workflow without an accepted result and releases the guard', async () => {
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => { throw new Error('EXPECTED_FAILURE'); } });
  const guard = new StudioGate(() => false), workflow = setup({ agent: createMeetingAgent({ model }), guard });
  const result = await (await workflow.createRun()).start({ inputData: input });
  assert.equal(result.status, 'failed'); assert.equal('result' in result && result.result?.accepted, false);
  assert.equal(guard.status().activeRuns, 0);
});

test('cancelling a running Workflow aborts its nested Agent and releases active execution', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const model = new MastraLanguageModelV2Mock({ doGenerate: options => new Promise((_resolve, reject) => {
    const abort = () => reject(options.abortSignal?.reason ?? new Error('cancelled'));
    options.abortSignal?.addEventListener('abort', abort, { once: true }); entered();
  }) });
  const guard = new StudioGate(() => false), workflow = setup({ agent: createMeetingAgent({ model }), guard });
  const run = await workflow.createRun(); const completion = run.start({ inputData: input });
  await started; assert.equal(guard.status().activeRuns, 1); await run.cancel();
  const result = await completion; assert.equal(result.status, 'canceled'); assert.equal(guard.status().activeRuns, 0);
});

test('concurrent Workflow runs keep authorized references isolated', async () => {
  const workflow = setup();
  const results = await Promise.all(['alice', 'bob'].map(async owner => (await workflow.createRun()).start({
    inputData: { ...input, notes: [{ id: owner, text: owner+' private reference' }] }, requestContext: new RequestContext() })));
  for (const [i, owner] of ['alice', 'bob'].entries()) {
    const result = results[i]; assert.equal(result.status, 'success');
    if (result.status === 'success') assert.deepEqual(result.result.artifact.output.sourceIds, [owner]);
  }
});

test('workflow lifecycle keeps a ticket between steps and through delayed cancellation cleanup', async () => {
  let draining = false; const guard = new StudioGate(() => draining), lifecycle = new WorkflowLifecycle(guard);
  lifecycle.start('test'); await lifecycle.step('test', new AbortController().signal, async () => 1);
  draining = true; assert.equal(guard.status().activeRuns, 1);
  let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  const running = lifecycle.step('test', new AbortController().signal, () => wait);
  lifecycle.finish('test'); assert.equal(guard.status().activeRuns, 1);
  finish(); await running; lifecycle.finish('test'); assert.equal(guard.status().activeRuns, 0);
  await assert.rejects(() => lifecycle.step('restart', new AbortController().signal, async () => 1), /STUDIO_DRAINING/);
});
