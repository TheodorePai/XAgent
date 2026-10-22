import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Run inside the isolated verification container. Credentials stay in its env.
const base = new URL(process.argv[2] || 'http://127.0.0.1:4411');
assert.equal(base.hostname, '127.0.0.1');
assert.ok(process.env.DEEPSEEK_API_KEY?.trim(), 'DeepSeek key is not configured');
const report = { timestamp: new Date().toISOString(), sourceCommit: process.env.VERIFY_SOURCE_COMMIT,
  mode: 'deepseek', model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  entrypoint: 'Mastra standard HTTP /api/agents/travel-assistant/generate', passed: false };
function browserProcesses() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      return /(^|\u0000|\/)(chromium|chrome(?:_crashpad_handler)?|agent-browser(?:-[a-z0-9-]+)?)(\u0000|\s|$)/.test(command) ||
        (command.includes('/agent-browser/') && command.includes('daemon')) ? [Number(name)] : [];
    } catch { return []; }
  });
}
const started = Date.now();
try {
  const response = await fetch(new URL('/api/agents/travel-assistant/generate', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(200000),
    body: JSON.stringify({ messages: [{ role: 'user', content: '安排延吉三日游，偏重朝鲜族文化、美食和轻松步行。请实际搜索并读取至少两篇资料，尽量附上网页中真实加载的相关图片。没有出发地、日期或预算，请说明假设；不要编造实时价格。' }],
      requestContext: { config: { destination: '延吉', days: 3 }, mode: 'deepseek' } }),
  });
  report.status = response.status;
  const result = await response.json();
  report.finishReason = result.finishReason;
  report.usage = result.usage;
  report.response = result.text;
  report.tools = result.toolResults?.map(v => ({ tool: v.payload.toolName,
    simulated: v.payload.result?.simulated, error: v.payload.result?.error }));
  const submission = result.toolResults?.find(v => v.payload.toolName === 'submitTripPlan')?.payload.result;
  report.artifact = submission?.artifact;
  // Retain useful diagnostic data without serializing provider configs/headers.
  if (!submission?.accepted) report.toolResults = result.toolResults;
  assert.equal(response.status, 200, 'Standard Mastra HTTP request failed');
  assert.equal(result.finishReason, 'stop', 'Agent did not complete');
  assert.equal(submission?.accepted, true, 'No validated travel artifact was submitted');
  const { output, view } = submission.artifact;
  assert.equal(output.destination, '延吉'); assert.equal(output.days.length, 3);
  assert.ok(output.sources.filter(s => s.kind === 'page').length >= 2);
  assert.ok(result.usage?.totalTokens > 0, 'No real model usage was recorded');
  assert.ok(!JSON.stringify(output).includes('[MOCK]'));
  assert.ok(report.tools.every(t => !t.simulated));
  assert.ok(result.toolResults.some(v => v.payload.toolName === 'browserSearch' && v.payload.result?.provider === 'mastra-agent-browser'));
  assert.equal(view.messages.length, 3); assert.equal(view.protocol, 'v0.9.1');
  report.checks = { realModel: true, realBrowser: true, pages: output.sources.length,
    days: output.days.length, images: output.images.length, a2uiMessages: view.messages.length };
  for (let attempt = 0; attempt < 15 && browserProcesses().length; attempt++) await delay(1000);
  report.remainingBrowserPids = browserProcesses();
  assert.equal(report.remainingBrowserPids.length, 0, 'Browser processes remain after the Agent finishes');
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, code: error.code, message: error.message };
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - started;
  writeFileSync('/app/data/studio-real-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, elapsedMs: report.elapsedMs, checks: report.checks,
    error: report.error, usage: report.usage, remainingBrowserPids: report.remainingBrowserPids }));
}
