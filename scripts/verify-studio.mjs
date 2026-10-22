import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4111');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'This verification is for local Studio only');
const taskFiles = ['meeting-tasks.sqlite', 'meeting-tasks.sqlite-wal', 'meeting-lab-identities.json'];
function taskSnapshot() {
  return taskFiles.map(name => {
    const path = new URL('../data/' + name, import.meta.url);
    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
  });
}
const before = taskSnapshot(), started = Date.now();
const agents = await fetch(new URL('/api/agents', base), { signal: AbortSignal.timeout(15000) });
assert.equal(agents.status, 200); assert.ok((await agents.json())['travel-assistant']);
const response = await fetch(new URL('/api/agents/travel-assistant/generate', base), {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
  body: JSON.stringify({ messages: [{ role: 'user', content: '安排延吉三日游，偏重美食和步行。' }],
    requestContext: { config: { destination: '延吉', days: 3 }, mode: 'mock' } }),
});
assert.equal(response.status, 200);
const result = await response.json(); assert.equal(result.finishReason, 'stop');
const submission = result.toolResults.find(v => v.payload.toolName === 'submitTripPlan')?.payload.result;
assert.equal(submission?.accepted, true);
const { output, view } = submission.artifact;
assert.equal(output.destination, '延吉'); assert.equal(output.days.length, 3);
assert.equal(output.images.length, 2); assert.equal(view.messages.length, 3);
assert.equal(view.protocol, 'v0.9.1'); assert.match(result.text, /\[MOCK\]/);
assert.deepEqual(taskSnapshot(), before, 'Studio must not change formal task data');
const report = { timestamp: new Date().toISOString(), mode: 'mock', realModelCalled: false,
  realBrowserCalled: false, status: response.status, elapsedMs: Date.now() - started,
  formalTaskDataUnchanged: true, tools: result.toolResults.map(v => v.payload.toolName),
  response: result.text, artifact: submission.artifact };
writeFileSync(new URL('../docs/studio-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, tools: report.tools, days: output.days.length,
  images: output.images.length, a2uiMessages: view.messages.length, formalTaskDataUnchanged: true }));
