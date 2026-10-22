import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MeetingStore } from '../src/meeting/store.js';
import { meetingView } from '../src/meeting/view.js';

async function until<T>(read: () => Promise<T | undefined | false>, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(25); }
  throw new Error('Meeting condition timed out');
}
async function launch(directory: string) {
  let output = '';
  const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, DATA_DIR: directory,
    PORT: '0', HOST: '127.0.0.1', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', d => { output += d; }); child.stderr!.on('data', d => { output += d; });
  const base = await until(async () => {
    if (child.exitCode !== null) throw new Error(output);
    const line = output.split('\n').find(v => v.includes('"event":"listening"'));
    return line ? 'http://127.0.0.1:' + JSON.parse(line).port : undefined;
  }, 30000).catch(async error => { await stop(child); throw error; });
  return { child, base };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const done = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGTERM'); await done;
}
const event = (sequence: number, marker: string) => ({ eventId: randomUUID(), sequence,
  observedAt: new Date().toISOString(), meeting: { title: '会议-' + marker, agenda: '讨论-' + marker, startAt: new Date().toISOString() } });

test('one meeting Agent serves isolated persistent tasks and refreshable A2UI', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-meeting-'));
  let app = await launch(directory);
  const users = JSON.parse(readFileSync(join(directory, 'meeting-lab-identities.json'), 'utf8'));
  const api = async (token: string, path: string, body?: object, status = 200) => {
    const res = await fetch(app.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await res.json(); assert.equal(res.status, status, result.error); return result;
  };
  const tasks: { id: string; token: string; owner: string; marker: string }[] = [];
  const read = (task: typeof tasks[number]) => api(task.owner, '/v1/tasks/' + task.id);
  const settled = (task: typeof tasks[number], revision: number) => until(async () => {
    const value = await read(task); assert.equal(value.error, undefined);
    return value.publishedRevision === revision ? value : undefined;
  });
  try {
    await t.test('server identity and task-scoped device credentials cannot be overridden', async () => {
      await api('wrong', '/v1/tasks', undefined, 401);
      await api(users[0].token, '/v1/tasks', { name: 'injection', instruction: 'x', notes: [], ownerId: 'bob' }, 400);
      for (const [i, user] of users.entries()) for (let j = 0; j < 2; j++) {
        const marker = `USER${i}-TASK${j}-${randomUUID().slice(0, 6)}`;
        const created = await api(user.token, '/v1/tasks', { name: marker, instruction: '关注-' + marker,
          notes: [{ id: marker, text: '独立资料-' + marker }] }, 201);
        tasks.push({ id: created.task.id, token: created.deviceToken, owner: user.token, marker });
        assert.equal(created.task.agentId, 'meeting-prep'); assert.equal(created.task.deviceTokenHash, undefined);
      }
      await api(users[1].token, '/v1/tasks/' + tasks[0].id, undefined, 404);
      await api(users[1].token, '/v1/tasks/' + tasks[0].id + '/instruction', { instruction: 'change' }, 404);
      await api(tasks[1].token, `/v1/device/tasks/${tasks[0].id}/commands`, undefined, 401);
      await api(tasks[0].token, '/v1/tasks/' + tasks[0].id + '/view', undefined, 401);
      for (const user of users) assert.equal((await api(user.token, '/v1/tasks')).tasks.length, 2);
    });
    await t.test('watch installation ACK ends independently; four events trigger four isolated runs', async () => {
      for (const task of tasks) {
        const command = await api(task.token, `/v1/device/tasks/${task.id}/commands`);
        assert.equal(command.commands[0].tool, 'watchCalendar');
        await api(task.token, `/v1/device/tasks/${task.id}/events`, event(1, task.marker), 409);
        await api(task.token, `/v1/device/tasks/${task.id}/ack`, { commandId: task.id });
        assert.equal((await read(task)).runs.length, 0);
        await api(task.token, `/v1/device/tasks/${task.id}/events`, event(1, task.marker), 202);
      }
      for (const task of tasks) {
        const result = await settled(task, 1), output = JSON.stringify(result.brief);
        assert.ok(output.includes(task.marker));
        for (const other of tasks.filter(v => v.id !== task.id)) assert.ok(!output.includes(other.marker));
        assert.deepEqual(result.runs[0].trace.map((v: { tool: string }) => v.tool), ['searchMeetingNotes', 'submitBrief']);
      }
    });
    await t.test('A2UI uses a stable surface, snapshots on reconnect, and data-only updates', async () => {
      const task = tasks[0], initial = await api(task.owner, `/v1/tasks/${task.id}/view`);
      assert.equal(initial.messages.length, 3); assert.equal(initial.protocol, 'v0.9.1');
      assert.ok(initial.messages[0].createSurface); assert.equal(initial.messages[1].updateComponents.components[0].id, 'root');
      await api(task.owner, `/v1/tasks/${task.id}/instruction`, { instruction: '新关注点-成本-7832' }, 202);
      const result = await settled(task, 2); assert.match(JSON.stringify(result.brief), /7832/);
      const update = await api(task.owner, `/v1/tasks/${task.id}/view?after=1`);
      assert.equal(update.surfaceId, initial.surfaceId); assert.equal(update.messages.length, 1); assert.ok(update.messages[0].updateDataModel);
      assert.equal((await api(task.owner, `/v1/tasks/${task.id}/view?after=2`)).messages.length, 0);
      for (const other of tasks.slice(1)) assert.equal((await read(other)).publishedRevision, 1);
    });
    await t.test('duplicate, conflicting and out-of-order events have distinct receipts', async () => {
      const task = tasks[0], payload = event(2, '会议变更-9123');
      await api(task.token, `/v1/device/tasks/${task.id}/events`, payload, 202);
      const result = await settled(task, 3); assert.match(result.brief.summary, /9123/);
      const duplicate = await api(task.token, `/v1/device/tasks/${task.id}/events`, payload, 202);
      assert.equal(duplicate.duplicate, true);
      await api(task.token, `/v1/device/tasks/${task.id}/events`, { ...payload, sequence: 3 }, 409);
      await api(task.token, `/v1/device/tasks/${task.id}/events`, event(1, 'old'), 409);
      assert.equal((await read(task)).runs.length, result.runs.length);
    });
    await t.test('committed inbox work and subscription survive a new server process', async () => {
      const task = tasks[1]; await stop(app.child);
      const ledger = new MeetingStore(directory);
      ledger.receive(task.id, task.token, event(2, '重启收件箱-5274')); ledger.close();
      app = await launch(directory);
      const result = await settled(task, 2); assert.match(result.brief.summary, /5274/);
      assert.equal(result.subscription, 'active');
      assert.equal((await api(task.owner, `/v1/tasks/${task.id}/view`)).messages.length, 3);
    });
    await t.test('pause revokes subscription and prevents late publication or events', async () => {
      const task = tasks[2]; await api(task.owner, `/v1/tasks/${task.id}/pause`, {});
      await api(task.token, `/v1/device/tasks/${task.id}/events`, event(2, 'late'), 410);
      await api(task.owner, `/v1/tasks/${task.id}/instruction`, { instruction: 'late' }, 409);
      assert.equal((await api(task.token, `/v1/device/tasks/${task.id}/commands`)).commands[0].tool, 'stopWatchCalendar');
    });
  } finally {
    await stop(app.child);
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.includes('xagent-meeting-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('a superseded generation cannot overwrite a newer input or mix its published title', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-meeting-cas-'));
  const store = new MeetingStore(directory);
  try {
    const created = store.create('alice', { name: 'CAS', instruction: 'prepare', mode: 'mock', notes: [] });
    store.ack(created.task.id, created.deviceToken);
    store.receive(created.task.id, created.deviceToken, event(1, 'old-title'));
    const snapshot = store.task(created.task.id);
    const brief = { summary: 'first summary', checklist: ['one'], sourceIds: [] };
    assert.equal(store.publish(snapshot, brief), true);
    store.receive(created.task.id, created.deviceToken, event(2, 'new-title'));
    assert.equal(store.publish(snapshot, { ...brief, summary: 'stale overwrite' }), false);
    const current = store.task(created.task.id), view = meetingView(current, true);
    assert.equal(current.publishedRevision, 1); assert.equal(current.brief!.summary, 'first summary');
    assert.ok(JSON.stringify(view).includes('old-title')); assert.ok(!JSON.stringify(view).includes('new-title'));
    assert.equal(store.publish(current, { ...brief, summary: 'latest' }), true);
  } finally {
    store.close(); const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('xagent-meeting-cas-'));
    rmSync(target, { recursive: true, force: true });
  }
});
