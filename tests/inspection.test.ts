import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../src/tasks/store.js';
import { definitions } from '../src/agents/registry.js';
import { meetingView } from '../src/meeting/view.js';
import { MeetingStore } from '../src/meeting/store.js';

async function until<T>(read: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(25); }
  throw new Error('Inspection condition timed out');
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
  }).catch(async error => { await stop(child); throw error; });
  return { child, base };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const done = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGTERM'); await done;
}
function cleanup(directory: string) {
  const target = resolve(directory);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('xagent-inspection-'));
  rmSync(target, { recursive: true, force: true });
}
const observation = (sequence: number, sourceId: string, content: string) => ({ eventId: randomUUID(), sequence,
  observedAt: new Date().toISOString(), observation: { sourceId, title: '资料更新', content } });

test('two Agent definitions share task infrastructure across two users', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-inspection-'));
  let app = await launch(directory);
  const users = JSON.parse(readFileSync(join(directory, 'meeting-lab-identities.json'), 'utf8'));
  const api = async (token: string, path: string, body?: object, expected = 200) => {
    const res = await fetch(app.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await res.json(); assert.equal(res.status, expected, result.error); return result;
  };
  const tasks: { id: string; device: string; owner: string; agent: string; marker: string; source: string }[] = [];
  const detail = (task: typeof tasks[number]) => api(task.owner, '/v1/tasks/' + task.id);
  const settled = (task: typeof tasks[number], revision: number) => until(async () => {
    const value = await detail(task); assert.equal(value.error, undefined);
    return value.publishedRevision === revision ? value : undefined;
  });
  const emit = (task: typeof tasks[number], payload: object, status = 202) => api(task.device, `/v1/device/tasks/${task.id}/events`, payload, status);
  try {
    await t.test('registry validates definitions, per-domain config, and per-domain events', async () => {
      await api(users[0].token, '/v1/tasks', { name: 'bad', agentId: 'missing', instruction: 'x', notes: [] }, 400);
      await api(users[0].token, '/v1/tasks', { name: 'bad', agentId: 'information-watch', instruction: 'x', notes: [] }, 400);
      for (const user of users) for (const agent of ['meeting-prep', 'information-watch']) {
        const marker = randomUUID().slice(0, 8), source = 'source-' + marker;
        const result = await api(user.token, '/v1/tasks', { name: marker, agentId: agent, instruction: '关注-' + marker,
          config: agent === 'information-watch' ? { sourceId: source } : {}, notes: [{ id: marker, text: '资料-' + marker }] }, 201);
        const task = { id: result.task.id, owner: user.token, device: result.deviceToken, marker, source, agent }; tasks.push(task);
        const cmd = (await api(task.device, `/v1/device/tasks/${task.id}/commands`)).commands[0];
        assert.equal(cmd.tool, agent === 'information-watch' ? 'watchInformation' : 'watchCalendar');
        if (agent === 'information-watch') assert.equal(cmd.filter.sourceId, source);
        await api(task.device, `/v1/device/tasks/${task.id}/ack`, { commandId: task.id });
      }
      await emit(tasks[1], { eventId: randomUUID(), sequence: 1, observedAt: new Date().toISOString(), meeting: { title: 'x', agenda: 'x', startAt: new Date().toISOString() } }, 400);
      await emit(tasks[0], observation(1, tasks[0].source, 'wrong event'), 400);
      await emit(tasks[1], observation(1, 'not-bound-source', 'wrong source'), 403);
    });
    await t.test('mixed Agents execute under the same owner and global scheduler without data leakage', async () => {
      for (const task of tasks) {
        await emit(task, task.agent === 'information-watch' ? observation(1, task.source, '初始资料-' + task.marker) :
          { eventId: randomUUID(), sequence: 1, observedAt: new Date().toISOString(), meeting: { title: task.marker, agenda: '会议-' + task.marker, startAt: new Date().toISOString() } });
      }
      for (const task of tasks) {
        const value = await settled(task, 1);
        assert.ok(JSON.stringify(value.output).includes(task.marker));
        for (const other of tasks.filter(v => v.id !== task.id)) assert.ok(!JSON.stringify(value.output).includes(other.marker));
        assert.equal(value.runs[0].agentId, task.agent);
        if (task.agent === 'information-watch') {
          assert.equal(value.output.change, 'initial'); assert.equal(value.output.notification, 'quiet');
          assert.deepEqual(value.runs[0].trace.map((v: { tool: string }) => v.tool), ['readPreviousObservation', 'searchReferenceNotes', 'submitInspection']);
        } else assert.deepEqual(value.brief, value.output);
        assert.equal((await api(task.owner, `/v1/tasks/${task.id}/view`)).messages.length, 3);
      }
      await api(users[1].token, '/v1/tasks/' + tasks[1].id, undefined, 404);
      await api(tasks[3].device, `/v1/device/tasks/${tasks[1].id}/commands`, undefined, 401);
      const all = (await Promise.all(tasks.map(detail))).flatMap(v => v.runs);
      for (const current of all) {
        const middle = (Date.parse(current.startedAt) + Date.parse(current.endedAt)) / 2;
        const overlapping = all.filter(v => Date.parse(v.startedAt) <= middle && Date.parse(v.endedAt) > middle);
        assert.ok(overlapping.length <= 2);
        assert.ok(overlapping.filter(v => v.ownerId === current.ownerId).length <= 1);
      }
    });
    await t.test('changed observations notify; unchanged observations publish quietly; duplicate is free', async () => {
      const task = tasks[1], changed = observation(2, task.source, '重要变更-' + task.marker);
      await emit(task, changed); let value = await settled(task, 2);
      assert.equal(value.output.change, 'changed'); assert.equal(value.output.notification, 'notify');
      assert.match(value.output.summary, /重要变更/);
      assert.equal((await emit(task, changed)).duplicate, true); assert.equal((await detail(task)).runs.length, value.runs.length);
      await emit(task, { ...changed, eventId: randomUUID(), sequence: 1 }, 409);
      await emit(task, observation(3, task.source, changed.observation.content)); value = await settled(task, 3);
      assert.equal(value.output.change, 'unchanged'); assert.equal(value.output.notification, 'quiet');
      for (const other of tasks.filter(v => v.id !== task.id)) assert.equal((await detail(other)).publishedRevision, 1);
    });
    await t.test('user refresh keeps the task baseline and affects only its own output', async () => {
      const task = tasks[1];
      await api(task.owner, `/v1/tasks/${task.id}/instruction`, { instruction: '新增关注点-8811' }, 202);
      const value = await settled(task, 4);
      assert.match(value.output.summary, /8811/); assert.equal(value.output.change, 'unchanged');
      assert.equal((await detail(tasks[0])).publishedRevision, 1);
    });
    await t.test('restart recovers shared pending work and the inspection baseline', async () => {
      const task = tasks[1]; await stop(app.child);
      const store = new TaskStore(directory, definitions);
      store.receive(task.id, task.device, observation(4, task.source, '重启新内容-5429'));
      store.recordRun({ id: randomUUID(), taskId: task.id, agentId: task.agent, status: 'running', revision: 5 }); store.close();
      app = await launch(directory); const value = await settled(task, 5);
      assert.equal(value.output.change, 'changed'); assert.match(value.output.summary, /5429/);
      assert.equal(value.subscription, 'active'); assert.equal(value.runs.filter((r: { status: string }) => r.status === 'interrupted').length, 1);
      assert.equal((await detail(tasks[0])).publishedRevision, 1);
    });
    await t.test('shared pause revokes monitoring for either domain', async () => {
      const task = tasks[1]; await api(task.owner, `/v1/tasks/${task.id}/pause`, {});
      await emit(task, observation(5, task.source, 'late'), 410);
      assert.equal((await api(task.device, `/v1/device/tasks/${task.id}/commands`)).commands[0].tool, 'stopWatchInformation');
    });
  } finally { await stop(app.child); cleanup(directory); }
});

test('legacy meeting documents retain their last complete result through normalization', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xagent-inspection-legacy-'));
  const store = new MeetingStore(directory);
  try {
    const created = store.create('alice', { name: 'old', instruction: 'x', notes: [] });
    const event = { eventId: randomUUID(), sequence: 2, observedAt: new Date().toISOString(), meeting: { title: 'new-unpublished', agenda: 'x', startAt: new Date().toISOString() } };
    const old = { ...store.task(created.task.id), revision: 2, publishedRevision: 1, fact: event,
      brief: { summary: 'old-result', checklist: ['prepare'], sourceIds: [] }, briefMeeting: { ...event.meeting, title: 'old-published' } };
    store.db.prepare('UPDATE tasks SET document=? WHERE id=?').run(JSON.stringify(old), created.task.id);
    const loaded = store.task(created.task.id);
    assert.equal(loaded.output!.summary, 'old-result');
    const view = JSON.stringify(meetingView(loaded, true));
    assert.ok(view.includes('old-published')); assert.ok(!view.includes('new-unpublished'));
  } finally { store.close(); cleanup(directory); }
});
