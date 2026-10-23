import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:4411' },
  mode: { type: 'string', default: 'mock' }, agents: { type: 'string', default: 'meeting-prep,information-watch' },
  output: { type: 'string' }, commit: { type: 'string' } } });
const base = new URL(values.base);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password);
assert.ok(['mock', 'deepseek'].includes(values.mode)); assert.ok(values.output, '--output is required');
const presets = JSON.parse(readFileSync(new URL('../studio-presets.json', import.meta.url), 'utf8'));
const definitions = {
  'meeting-prep': { context: presets['参会准备（DeepSeek，合成会议资料）'], tool: 'submitBrief',
    prompt: '为发布评审生成简报和清单，关注15秒超时、负责人和回滚，保留来源编号release-042。',
    tools: ['searchMeetingNotes', 'submitBrief'] },
  'information-watch': { context: presets['信息巡检（DeepSeek，合成变更事件）'], tool: 'submitInspection',
    prompt: '按RULE-731比较当前观察与基线，说明延期及阻断项、负责人，给出提醒建议，保留来源编号。不要发送通知。',
    tools: ['readPreviousObservation', 'searchReferenceNotes', 'submitInspection'] },
  'travel-assistant': { context: presets['延吉三日游（DeepSeek + 浏览器）'], tool: 'submitTripPlan',
    prompt: '安排延吉三日游，关注美食、朝鲜族文化和轻松步行。未提供日期和预算，请说明假设。最多搜索三次，然后读取至少两个页面、整理网页加载图片并提交计划；不编造实时价格。',
    tools: ['browserSearch', 'browserRead', 'browserImages', 'submitTripPlan'] },
};
const agents = values.agents.split(',');
assert.ok(agents.length <= 3 && new Set(agents).size === agents.length && agents.every(a => definitions[a]));
const report = { type: 'agent-api', mode: values.mode, requestedCommit: values.commit, startedAt: new Date().toISOString(),
  passed: false, uiVerified: false, syntheticInputs: true, checks: [] };
function browsers() {
  return readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
    try { const cmd = readFileSync(`/proc/${n}/cmdline`, 'utf8');
      return /(^|\u0000|\/)(chromium|chrome(?:_crashpad_handler)?|agent-browser)(\u0000|\s|$)/.test(cmd) || cmd.includes('/agent-browser/') && cmd.includes('daemon') ? [Number(n)] : [];
    } catch { return []; }
  });
}
try {
  const status = await fetch(new URL('/xagent/status', base), { signal: AbortSignal.timeout(10000) });
  assert.equal(status.status, 200); report.service = await status.json();
  assert.equal(report.service.service, 'xagent-studio'); assert.equal(report.service.draining, false);
  assert.equal(report.service.activeRuns, 0, 'Do not verify against an already active Studio');
  if (values.commit) assert.equal(report.service.build.commit, values.commit, 'Running source version mismatch');
  if (values.mode === 'deepseek') assert.ok(report.service.deepseekConfigured && process.env.DEEPSEEK_API_KEY?.trim());
  for (const id of agents) {
    const spec = definitions[id], started = Date.now();
    const response = await fetch(new URL(`/api/agents/${id}/generate`, base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ messages: [{ role: 'user', content: spec.prompt }], requestContext: { ...spec.context, mode: values.mode } }),
    });
    assert.equal(response.status, 200, `${id}: HTTP error ${response.status}`);
    const result = await response.json(), tools = result.toolResults.map(v => v.payload);
    const submitted = tools.findLast(t => t.toolName === spec.tool && t.result?.accepted)?.result;
    assert.equal(result.finishReason, 'stop'); assert.equal(submitted?.accepted, true, `${id}: no accepted artifact`);
    assert.ok(spec.tools.every(name => tools.some(t => t.toolName === name)));
    assert.equal(submitted.artifact.view.messages.length, 3);
    assert.ok(result.text?.trim());
    const output = submitted.artifact.output;
    if (values.mode === 'deepseek') {
      assert.ok(result.usage?.totalTokens > 0); assert.ok(!JSON.stringify(output).includes('[MOCK]'));
    } else assert.match(JSON.stringify(output), /\[MOCK\]/);
    if (id === 'meeting-prep') assert.ok(output.sourceIds.includes('release-042') && /15/.test(output.summary));
    if (id === 'information-watch') { assert.equal(output.change, 'changed'); assert.equal(output.notification, 'notify'); }
    if (id === 'travel-assistant') {
      assert.equal(output.days.length, 3); assert.ok(output.sources.filter(s => s.kind === 'page').length >= 2);
      if (values.mode === 'deepseek') assert.ok(tools.some(t => t.toolName === 'browserSearch' && t.result?.provider === 'mastra-agent-browser'));
    }
    report.checks.push({ agentId: id, elapsedMs: Date.now() - started, usage: result.usage,
      tools: tools.map(t => ({ name: t.toolName, accepted: t.result?.accepted, error: !!t.result?.error })),
      artifact: submitted.artifact, text: result.text });
  }
  for (let n = 0; n < 15 && browsers().length; n++) await delay(500);
  report.remainingBrowserPids = browsers(); assert.equal(report.remainingBrowserPids.length, 0);
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, mode: values.mode, calls: report.checks.length, error: report.error }));
}
