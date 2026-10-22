import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';

async function launch(directory: string) {
  let output = '';
  const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, DATA_DIR: directory,
    PORT: '0', HOST: '127.0.0.1', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', data => { output += data.toString(); });
  child.stderr!.on('data', data => { output += data.toString(); });
  const base = await until(async () => {
    if (child.exitCode !== null) throw new Error(output);
    const line = output.split('\n').find(line => line.includes('"event":"listening"'));
    return line ? `http://127.0.0.1:${JSON.parse(line).port}` : undefined;
  }, 30000).catch(async error => { await stop(child); throw error; });
  return { child, base };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM'); await exited;
}
async function until<T>(read: () => Promise<T | undefined | false>, timeout = 12000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(30); }
  throw new Error('Condition timed out');
}
async function api(base: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const success = (data: object) => ({ status: 'succeeded', observedAt: new Date().toISOString(), data });
async function pending(base: string, id: string, tool: string) {
  return until(async () => {
    const run = (await api(base, '/runs/' + id)).body;
    if (run.status === 'failed') throw new Error(JSON.stringify(run));
    return run.jobs.find((job: { tool: string; status: string }) => job.tool === tool && job.status === 'pending');
  });
}
async function final(base: string, id: string) {
  return until(async () => {
    const run = (await api(base, '/runs/' + id)).body;
    return ['completed', 'failed', 'canceled'].includes(run.status) ? run : undefined;
  });
}

test('Mastra + device broker integration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-mastra-'));
  let app = await launch(directory);
  try {
    await t.test('tool result changes the next decision; two fast reads stay in the run', async () => {
      const run = (await api(app.base, '/runs', {})).body;
      const battery = await pending(app.base, run.id, 'readBattery');
      await api(app.base, '/devices/sim-phone/results/' + battery.id, success({ level: 82, charging: false }));
      const calendar = await pending(app.base, run.id, 'queryCalendar');
      await api(app.base, '/devices/sim-phone/results/' + calendar.id,
        success({ events: [{ title: '只有工具知道的会议-7391', startAt: new Date().toISOString() }] }));
      const result = await final(app.base, run.id);
      assert.equal(result.status, 'completed');
      assert.match(result.text, /82/); assert.match(result.text, /7391/);
      assert.equal(result.events.filter((e: { type: string }) => e.type === 'tool.returned').length, 2);
    });
    await t.test('low battery ends without querying calendar', async () => {
      const run = (await api(app.base, '/runs', {})).body;
      const battery = await pending(app.base, run.id, 'readBattery');
      await api(app.base, '/devices/sim-phone/results/' + battery.id, success({ level: 12, charging: false }));
      const result = await final(app.base, run.id);
      assert.match(result.text, /12%/); assert.equal(result.jobs.length, 1);
    });
    await t.test('suspended photo survives a new server process; retries do not rerun it', async () => {
      const run = (await api(app.base, '/runs', { scenario: 'photo' })).body;
      const photo = await pending(app.base, run.id, 'capturePhoto');
      await until(async () => (await api(app.base, '/runs/' + run.id)).body.status === 'waiting_device');
      await stop(app.child); app = await launch(directory);
      assert.equal((await api(app.base, '/runs/' + run.id)).body.status, 'waiting_device');
      const payload = success({ description: '重启后手机返回的蓝色纸条-8624', simulated: true });
      assert.equal((await api(app.base, '/devices/sim-phone/results/' + photo.id, payload)).status, 200);
      const completed = await final(app.base, run.id);
      assert.equal(completed.status, 'completed'); assert.match(completed.text, /8624/);
      const duplicate = await api(app.base, '/devices/sim-phone/results/' + photo.id, payload);
      assert.equal(duplicate.body.duplicate, true);
      assert.equal((await api(app.base, '/devices/sim-phone/results/' + photo.id,
        { ...payload, data: { description: 'different', simulated: true } })).status, 409);
      assert.equal((await api(app.base, '/runs/' + run.id)).body.events.filter((e: { type: string }) => e.type === 'agent.resuming').length, 1);
    });
    await t.test('restart resumes the current pending tool, not an older completed one', async () => {
      const run = (await api(app.base, '/runs', {})).body;
      const battery = await pending(app.base, run.id, 'readBattery');
      await api(app.base, '/devices/sim-phone/results/' + battery.id, success({ level: 66, charging: true }));
      const calendar = await pending(app.base, run.id, 'queryCalendar');
      await until(async () => (await api(app.base, '/runs/' + run.id)).body.status === 'waiting_device');
      await stop(app.child);
      // Simulate a crash after receipt commit but before the resume was scheduled.
      const ledger = new Store(directory);
      ledger.receive(calendar.id, success({ events: [{ title: '持久回调-9452', startAt: new Date().toISOString() }] }));
      ledger.close();
      app = await launch(directory);
      const result = await final(app.base, run.id);
      assert.equal(result.status, 'completed'); assert.match(result.text, /9452/);
      assert.equal(result.jobs.length, 2);
    });
    await t.test('cancel persists across restart and rejects late device results', async () => {
      const run = (await api(app.base, '/runs', { scenario: 'photo' })).body;
      const photo = await pending(app.base, run.id, 'capturePhoto');
      await api(app.base, '/runs/' + run.id + '/cancel', {});
      await stop(app.child); app = await launch(directory);
      assert.equal((await api(app.base, '/devices/sim-phone/results/' + photo.id,
        success({ description: 'late', simulated: true }))).status, 410);
      const result = (await api(app.base, '/runs/' + run.id)).body;
      assert.equal(result.status, 'canceled');
      assert.equal(result.events.filter((e: { type: string }) => e.type === 'agent.resuming').length, 0);
    });
    await t.test('timeout is terminal and missing key cannot silently fall back', async () => {
      const run = (await api(app.base, '/runs', { scenario: 'photo', jobTtlMs: 200 })).body;
      const result = await final(app.base, run.id);
      assert.equal(result.status, 'failed'); assert.equal(result.error, 'DEVICE_TIMEOUT');
      assert.equal((await api(app.base, '/devices/sim-phone/results/' + result.jobs[0].id,
        success({ description: 'too late', simulated: true }))).status, 410);
      assert.equal((await api(app.base, '/runs', { mode: 'deepseek' })).status, 412);
    });
    await t.test('invalid and denied observations are not treated as successful empty data', async () => {
      const run = (await api(app.base, '/runs', {})).body;
      const battery = await pending(app.base, run.id, 'readBattery');
      assert.equal((await api(app.base, '/devices/sim-phone/results/' + battery.id, success({ level: 500, charging: true }))).status, 400);
      assert.equal((await api(app.base, '/devices/sim-phone/results/' + battery.id,
        { status: 'failed', observedAt: new Date().toISOString(), error: 'permission_denied' })).status, 200);
      const result = await final(app.base, run.id);
      assert.match(result.text, /permission_denied/); assert.equal(result.jobs.length, 1);
    });
  } finally {
    await stop(app.child);
    rmSync(directory, { recursive: true, force: true });
  }
});
