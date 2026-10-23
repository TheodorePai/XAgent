import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:4411' },
  mode: { type: 'string', default: 'mock' }, output: { type: 'string' }, commit: { type: 'string' } } });
const base = new URL(values.base);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname) && !base.username && !base.password);
assert.ok(['mock', 'deepseek'].includes(values.mode)); assert.ok(values.output);
const report = { type: 'workflow-api', workflowId: 'meeting-brief', mode: values.mode, passed: false,
  uiVerified: false, syntheticInputs: true, startedAt: new Date().toISOString() };
async function api(path, body) {
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `Workflow HTTP ${response.status}`); return response.json();
}
let finished = false;
try {
  report.service = await api('/xagent/status');
  assert.equal(report.service.service, 'xagent-studio'); assert.equal(report.service.activeRuns, 0); assert.equal(report.service.draining, false);
  if (values.commit) assert.equal(report.service.build.commit, values.commit);
  if (values.mode === 'deepseek') assert.ok(report.service.deepseekConfigured);
  const input = JSON.parse(readFileSync(new URL('../workflow-inputs.json', import.meta.url), 'utf8'))['meeting-brief'];
  report.input = { ...input, mode: values.mode };
  const created = await api('/api/workflows/meeting-brief/create-run', {}); report.runId = created.runId;
  assert.ok(report.runId);
  await api('/api/workflows/meeting-brief/start?runId=' + encodeURIComponent(report.runId), { inputData: report.input });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const run = await api('/api/workflows/meeting-brief/runs/' + encodeURIComponent(report.runId) + '?fields=result,steps,error');
    if (['pending', 'running', 'waiting'].includes(run.status)) { await delay(750); continue; }
    finished = true; report.status = run.status; assert.equal(run.status, 'success', `Workflow ${run.status}`);
    assert.ok(['prepare-meeting', 'draft-with-agent', 'validate-brief'].every(id => run.steps[id]?.status === 'success'));
    const output = run.result;
    assert.equal(output.accepted, true); assert.equal(output.mode, values.mode);
    assert.equal(output.artifact.view.messages.length, 3); assert.ok(output.artifact.output.sourceIds.includes('release-042'));
    assert.match(output.artifact.output.summary, /15/); assert.ok(output.text.trim());
    if (values.mode === 'deepseek') { assert.ok(output.usage.totalTokens > 0); assert.ok(!JSON.stringify(output).includes('[MOCK]')); }
    else assert.match(output.text, /\[MOCK\]/);
    report.steps = Object.fromEntries(['prepare-meeting', 'draft-with-agent', 'validate-brief'].map(id => [id, run.steps[id].status]));
    report.result = output; report.passed = true; break;
  }
  assert.ok(report.passed, 'Workflow timed out');
} catch (error) {
  report.error = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  if (report.runId && !finished) {
    try { await api('/api/workflows/meeting-brief/runs/' + encodeURIComponent(report.runId) + '/cancel', {}); report.cancelRequested = true; }
    catch { report.cancelRequested = false; }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, mode: values.mode, runId: report.runId, error: report.error }));
}
