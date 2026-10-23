import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { resolveMode } from '../src/agents/model.js';
import { createMeetingAgent, meetingContextSchema } from '../src/agents/meeting.js';
import { createInspectionAgent, inspectionContextSchema } from '../src/agents/inspection.js';
import { createTravelAgent } from '../src/agents/travel.js';
import { travelContextSchema } from '../src/agents/travel-context.js';

const examples = [
  { factory: createMeetingAgent, schema: meetingContextSchema, tool: 'submitBrief', input: {
    meeting: { title: '模式验收', agenda: '回滚', startAt: '2026-11-03T10:00:00+08:00' }, notes: [] } },
  { factory: createInspectionAgent, schema: inspectionContextSchema, tool: 'submitInspection', input: {
    observation: { sourceId: 'release', title: '发布状态', content: '准时上线' }, notes: [] } },
  { factory: createTravelAgent, schema: travelContextSchema, tool: 'submitTripPlan', input: {
    config: { destination: '延吉', days: 3 } } },
];
function environment(t: TestContext, values: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const assign = (data: typeof values) => { for (const [key, value] of Object.entries(data)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  assign(values); t.after(() => assign(before));
}

test('all Agents resolve default DeepSeek metadata and input mode without network calls', async t => {
  environment(t, { XAGENT_DEFAULT_MODE: 'deepseek', DEEPSEEK_API_KEY: 'local-test-placeholder', DEEPSEEK_MODEL: 'deepseek-flash' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('METADATA_MUST_NOT_CALL_NETWORK'); });
  for (const example of examples) {
    const value = example.factory(); new Mastra({ agents: { value }, logger: false });
    assert.equal(example.schema.parse(example.input).mode, 'deepseek');
    const model = await value.getModel();
    assert.equal(model.modelId, 'deepseek-flash'); assert.match(model.provider, /deepseek/);
    const mock = await value.getModel({ requestContext: new RequestContext([['mode', 'mock']]) });
    assert.equal(mock.provider, 'xagent-test-fixture');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('explicit mock executes all tools offline even when deployment defaults to DeepSeek without a key', async t => {
  environment(t, { XAGENT_DEFAULT_MODE: 'deepseek', DEEPSEEK_API_KEY: undefined });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('MOCK_MUST_NOT_CALL_NETWORK'); });
  for (const example of examples) {
    const input = { ...example.input, mode: 'mock' };
    assert.equal(example.schema.parse(input).mode, 'mock');
    const value = example.factory(); new Mastra({ agents: { value }, logger: false });
    const result = await value.generate('模式回归', { requestContext: new RequestContext(Object.entries(input)) });
    assert.equal(result.toolResults.find(t => t.payload.toolName === example.tool)?.payload.result.accepted, true);
    assert.match(result.text, /\[MOCK\]/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('missing key never falls back to mock for default or explicit DeepSeek', async t => {
  environment(t, { XAGENT_DEFAULT_MODE: 'deepseek', DEEPSEEK_API_KEY: undefined });
  for (const example of examples) {
    const value = example.factory(); new Mastra({ agents: { value }, logger: false });
    await assert.rejects(() => value.getModel(), /DEEPSEEK_KEY_NOT_CONFIGURED/);
    process.env.XAGENT_DEFAULT_MODE = 'mock';
    await assert.rejects(() => value.getModel({ requestContext: new RequestContext([['mode', 'deepseek']]) }), /DEEPSEEK_KEY_NOT_CONFIGURED/);
    process.env.XAGENT_DEFAULT_MODE = 'deepseek';
  }
});

test('invalid modes are rejected, while explicit task modes override deployment defaults', t => {
  environment(t, { XAGENT_DEFAULT_MODE: 'invalid' });
  assert.throws(() => resolveMode());
  assert.equal(resolveMode('mock'), 'mock');
  assert.equal(resolveMode('deepseek'), 'deepseek');
  for (const mode of [null, '', 'invalid']) assert.throws(() => resolveMode(mode));
  delete process.env.XAGENT_DEFAULT_MODE;
  assert.equal(resolveMode(), 'mock');
});
