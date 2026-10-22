import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { allowedContentURL, browserSearch, browserRead, webEvidence } from '../src/tools/browser.js';
import type { Scope } from '../src/tasks/types.js';
import { TaskStore } from '../src/tasks/store.js';
import { definitions } from '../src/agents/registry.js';

async function until<T>(read: () => Promise<T | undefined | false>) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(30); }
  throw new Error('Travel condition timed out');
}
test('travel plans run from a user request, with scoped web evidence and existing publication checks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-travel-'));
  let output = '';
  const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, DATA_DIR: directory, PORT: '0', HOST: '127.0.0.1', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', d => { output += d; }); child.stderr!.on('data', d => { output += d; });
  try {
    const base = await until(async () => {
      if (child.exitCode !== null) throw new Error(output);
      const line = output.split('\n').find(v => v.includes('"event":"listening"'));
      return line ? 'http://127.0.0.1:' + JSON.parse(line).port : undefined;
    });
    const users = JSON.parse(readFileSync(join(directory, 'meeting-lab-identities.json'), 'utf8'));
    const api = async (token: string, path: string, body?: object, expected = 200) => {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await res.json(); assert.equal(res.status, expected, value.error); return value;
    };
    const created = await api(users[0].token, '/v1/tasks', { name: '延吉行程', agentId: 'travel-assistant',
      instruction: '安排三日游', config: { destination: '延吉', days: 3 }, notes: [] }, 201);
    assert.equal(created.deviceToken, undefined); assert.equal(created.task.subscription, 'not_required');
    const task = await until(async () => {
      const current = await api(users[0].token, '/v1/tasks/' + created.task.id);
      assert.equal(current.error, undefined);
      return current.publishedRevision === 1 ? current : undefined;
    });
    assert.equal(task.output.destination, '延吉'); assert.equal(task.output.days.length, 3);
    assert.ok(task.output.sources.every((s: { kind: string }) => s.kind === 'page'));
    assert.equal(task.output.images.length, 2);
    assert.deepEqual(task.runs[0].trace.map((v: { tool: string }) => v.tool), ['browserSearch', 'browserRead', 'browserRead', 'browserImages', 'submitTripPlan']);
    assert.equal((await api(users[0].token, `/v1/tasks/${task.id}/view`)).messages.length, 3);
    await api(users[1].token, '/v1/tasks/' + task.id, undefined, 404);
    await api(users[0].token, `/v1/device/tasks/${task.id}/commands`, undefined, 409);
    await api(users[0].token, `/v1/tasks/${task.id}/instruction`, { instruction: '想多吃美食-7832' }, 202);
    await until(async () => {
      const value = await api(users[0].token, '/v1/tasks/' + task.id);
      assert.equal(value.error, undefined);
      return value.publishedRevision === 2 && /7832/.test(value.output.summary);
    });
    await api(users[0].token, `/v1/tasks/${task.id}/pause`, {});
    await api(users[0].token, `/v1/tasks/${task.id}/instruction`, { instruction: 'late' }, 409);
  } finally {
    if (child.exitCode === null) { const done = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGTERM'); await done; }
    const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('xagent-travel-'));
    rmSync(target, { recursive: true, force: true });
  }
});
test('browser evidence cannot cross runs and content navigation excludes unapproved destinations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-travel-evidence-'));
  const store = new TaskStore(directory, definitions);
  try {
    const result = store.create('alice', { name: 'travel', instruction: 'x', notes: [], agentId: 'travel-assistant', config: { destination: '延吉', days: 3 } });
    const task = store.task(result.task.id);
    const one: Scope = { runId: 'one', task, trace: [] }, two: Scope = { runId: 'two', task, trace: [] };
    const search = await browserSearch(one, '延吉');
    assert.equal(webEvidence(two).sources.size, 0);
    await assert.rejects(() => browserRead(two, search.results[0].id), /SOURCE_NOT_DISCOVERED/);
    for (const url of ['http://127.0.0.1:4391/runs', 'file:///etc/passwd', 'https://www.jl.gov.cn.evil.example/x', 'https://user:pass@www.jl.gov.cn/']) assert.equal(allowedContentURL(url), false);
    assert.equal(allowedContentURL('https://www.jl.gov.cn/travel'), true);
  } finally {
    store.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('xagent-travel-evidence-'));
    rmSync(target, { recursive: true, force: true });
  }
});
