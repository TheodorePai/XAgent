import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createMeetingAgent } from '../src/agents/meeting.js';
import { createInspectionAgent } from '../src/agents/inspection.js';
import { bindNotesTask, notesRun, type NotesRun } from '../src/agents/notes-context.js';

const observation = { sourceId: 'release', title: '发布状态', content: '延期两小时，阻断项未解决' };
const examples = [
  { id: 'meeting-prep', factory: createMeetingAgent, tool: 'submitBrief', input: {
    mode: 'mock', meeting: { title: '发布评审', agenda: '回滚方案', startAt: '2026-11-03T10:00:00+08:00' },
    notes: [{ id: 'meeting-042', text: '回滚负责人林舟，阈值15秒' }] } },
  { id: 'information-watch', factory: createInspectionAgent, tool: 'submitInspection', input: {
    mode: 'mock', observation, previous: { ...observation, content: '准时上线，无阻断项' },
    notes: [{ id: 'rule-731', text: 'RULE-731 延期超过30分钟建议提醒' }] } },
];
function make(example: typeof examples[number], options = {}) {
  const value = example.factory(options); new Mastra({ agents: { value }, logger: false }); return value;
}
for (const example of examples) {
  for (const streaming of [false, true]) test(`${example.id} standalone ${streaming ? 'stream' : 'generate'} returns artifact`, async () => {
    const requestContext = new RequestContext(Object.entries(example.input));
    requestContext.setRaw(`xagent.${example.id}.execution`, { binding: { surfaceId: 'forged' } });
    let run: NotesRun | undefined;
    const options = { requestContext, onStepFinish: () => { run = notesRun(requestContext, example.id); } };
    const value = make(example);
    const result = streaming ? await value.stream('请关注延期和回滚 CHECK-814', options) : await value.generate('请关注延期和回滚 CHECK-814', options);
    if ('fullStream' in result) for await (const _chunk of result.fullStream) {}
    const output = 'getFullOutput' in result ? await result.getFullOutput() : result;
    const submitted = output.toolResults.find(v => v.payload.toolName === example.tool)?.payload.result;
    assert.equal(output.finishReason, 'stop'); assert.equal(submitted?.accepted, true);
    assert.equal(submitted.artifact.view.messages.length, 3);
    assert.match(submitted.artifact.view.surfaceId, /-preview-/); assert.ok(run?.closed);
    assert.match(submitted.artifact.output.summary, /CHECK-814/);
    assert.ok(submitted.artifact.output.sourceIds.includes(example.input.notes[0].id));
    assert.match(output.text, /CHECK-814/);
  });
  test(`${example.id} supports Studio signal wake and isolates reused context`, async () => {
    const value = make(example), requestContext = new RequestContext(Object.entries(example.input));
    const execute = async (text: string) => {
      const accepted = await value.sendMessage(text, { resourceId: 'test-studio', threadId: randomUUID(),
        ifIdle: { streamOptions: { requestContext } } }).accepted;
      assert.equal(accepted.action, 'wake'); if (accepted.action !== 'wake') throw new Error('Not a wake');
      for await (const _chunk of accepted.output.fullStream) {}
      const output = await accepted.output.getFullOutput();
      return output.toolResults.find(v => v.payload.toolName === example.tool)?.payload.result.artifact;
    };
    const first = await execute('first-1836'), second = await execute('second-7924');
    assert.match(first.output.summary, /1836/); assert.match(second.output.summary, /7924/);
    assert.doesNotMatch(second.output.summary, /1836/); assert.notEqual(first.view.surfaceId, second.view.surfaceId);
  });
  test(`${example.id} cannot publish when A2UI validation fails`, async () => {
    const requestContext = new RequestContext(); let published = false;
    bindNotesTask(requestContext, example.id, example.input as any, { runId: randomUUID(),
      surfaceId: 17 as unknown as string, revision: 1, instruction: 'test', trace: [], onResult: () => { published = true; } });
    const output = await make(example).generate('test', { requestContext }).catch(() => undefined);
    assert.equal(published, false); if (output) assert.notEqual(output.finishReason, 'stop');
  });
}
test('inspection deterministically separates initial / unchanged / changed', async () => {
  for (const [previous, change, notification] of [[null, 'initial', 'quiet'], [observation, 'unchanged', 'quiet'],
    [{ ...observation, content: '无阻断项' }, 'changed', 'notify']] as const) {
    const value = make(examples[1]);
    const output = await value.generate('关注延期', { requestContext: new RequestContext(Object.entries({ ...examples[1].input, previous })) });
    const result = output.toolResults.find(v => v.payload.toolName === 'submitInspection')!.payload.result.artifact.output;
    assert.equal(result.change, change); assert.equal(result.notification, notification);
  }
});
test('malformed contexts fail before model calls and do not accept mismatched observation sources', async () => {
  for (const example of examples) {
    const model = new MastraLanguageModelV2Mock({ doGenerate: async () => { throw new Error('MUST_NOT_CALL'); } });
    await assert.rejects(() => make(example, { model }).generate('test', { requestContext: new RequestContext([['mode', 'mock']]) }));
    assert.equal(model.doGenerateCalls.length, 0);
  }
  await assert.rejects(() => make(examples[1]).generate('test', { requestContext: new RequestContext(Object.entries({
    ...examples[1].input, previous: { ...observation, sourceId: 'foreign-source' } })) }));
});
test('concurrent meeting executions cannot share reference libraries', async () => {
  const value = make(examples[0]);
  const outputs = await Promise.all(['alice', 'bob'].map(owner => value.generate('test-'+owner, { requestContext:
    new RequestContext(Object.entries({ ...examples[0].input, notes: [{ id: owner, text: 'reference-'+owner }] })) })));
  for (const [i, owner] of ['alice', 'bob'].entries()) {
    const result = outputs[i].toolResults.find(v => v.payload.toolName === 'submitBrief')!.payload.result.artifact.output;
    assert.deepEqual(result.sourceIds, [owner]); assert.match(result.summary, new RegExp('reference-'+owner));
  }
});
