import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { LabError } from '../store.js';
import type { Registry, Task } from './types.js';
export type { Task } from './types.js';

export const createTaskSchema = z.object({ name: z.string().min(1).max(100),
  agentId: z.string().min(1).max(80).default('meeting-prep'),
  instruction: z.string().min(1).max(1000), mode: z.enum(['mock', 'deepseek']).default('mock'),
  config: z.record(z.string(), z.unknown()).optional(),
  notes: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(1500) }).strict()).max(8),
}).strict().refine(v => new Set(v.notes.map(n => n.id)).size === v.notes.length, 'Duplicate note ids');
const digest = (value: string) => createHash('sha256').update(value).digest();
const hash = (value: string) => digest(value).toString('hex');
const stamp = () => new Date().toISOString();
export class TaskStore {
  readonly db: DatabaseSync;
  private identities: { userId: string; token: string }[];
  constructor(directory: string, readonly definitions: Registry) {
    // Demonstration identity provider only; replace with verified OIDC identity.
    const path = join(directory, 'meeting-lab-identities.json');
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(['alice', 'bob'].map(userId =>
      ({ userId, token: randomBytes(32).toString('hex') }))), { mode: 0o600, flag: 'wx' });
    this.identities = z.array(z.object({ userId: z.string(), token: z.string().min(32) })).parse(JSON.parse(readFileSync(path, 'utf8')));
    this.db = new DatabaseSync(join(directory, 'meeting-tasks.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (task_id TEXT, event_id TEXT, document TEXT NOT NULL, PRIMARY KEY(task_id,event_id));
      CREATE TABLE IF NOT EXISTS meeting_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, document TEXT NOT NULL);`);
  }
  definition(id: string) {
    const definition = this.definitions.get(id);
    if (!definition) throw new LabError('UNKNOWN_AGENT', 400);
    return definition;
  }
  private normalize(task: Task) { return this.definition(task.agentId).normalize?.(task) || task; }
  authenticate(token: string) {
    const found = this.identities.find(i => timingSafeEqual(digest(i.token), digest(token)));
    if (!token || !found) throw new LabError('UNAUTHORIZED', 401);
    return found.userId;
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT document FROM tasks WHERE id=?').get(id);
    if (!row) throw new LabError('TASK_NOT_FOUND', 404);
    return this.normalize(JSON.parse(String(row.document)));
  }
  owned(id: string, owner: string) {
    const task = this.task(id);
    if (task.ownerId !== owner) throw new LabError('TASK_NOT_FOUND', 404);
    return task;
  }
  device(id: string, token: string) {
    const task = this.task(id);
    if (!this.definition(task.agentId).subscription) throw new LabError('DEVICE_SUBSCRIPTION_NOT_SUPPORTED', 409);
    if (!token || !timingSafeEqual(Buffer.from(task.deviceTokenHash, 'hex'), digest(token))) throw new LabError('UNAUTHORIZED_DEVICE', 401);
    return task;
  }
  tasks(): Task[] { return this.db.prepare('SELECT document FROM tasks ORDER BY rowid').all().map(r => this.normalize(JSON.parse(String(r.document)))); }
  public(task: Task) { const { deviceTokenHash, ...view } = task; return { ...view, ...this.definition(task.agentId).project?.(task) }; }
  private save(task: Task) {
    task.updatedAt = stamp();
    this.db.prepare('INSERT OR REPLACE INTO tasks(id,document) VALUES(?,?)').run(task.id, JSON.stringify(task));
    return task;
  }
  create(ownerId: string, raw: z.input<typeof createTaskSchema>) {
    const input = createTaskSchema.parse(raw), definition = this.definition(input.agentId);
    const config = definition.configSchema.parse(input.config || {});
    const token = randomBytes(32).toString('hex');
    const task: Task = { ...input, config, id: randomUUID(), ownerId, agentVersion: definition.version,
      status: 'active', subscription: 'pending', deviceTokenHash: hash(token), revision: 0, publishedRevision: 0,
      lastSequence: 0, createdAt: stamp(), updatedAt: stamp() };
    if (definition.initialEvent) {
      task.fact = definition.initialEvent(task); task.revision = 1;
      task.subscription = 'not_required'; task.deviceTokenHash = '';
    }
    this.save(task);
    return { task: this.public(task), ...(definition.subscription ? { deviceToken: token } : {}) };
  }
  ack(id: string, token: string) {
    const task = this.device(id, token);
    if (task.status !== 'active') throw new LabError('SUBSCRIPTION_REVOKED', 410);
    task.subscription = 'active'; return this.save(task);
  }
  receive(id: string, token: string, input: unknown) {
    const task = this.device(id, token);
    if (task.status !== 'active') throw new LabError('SUBSCRIPTION_REVOKED', 410);
    if (task.subscription !== 'active') throw new LabError('SUBSCRIPTION_NOT_ACKNOWLEDGED', 409);
    const event = this.definition(task.agentId).parseEvent(task, input);
    const prior = this.db.prepare('SELECT document FROM inbox WHERE task_id=? AND event_id=?').get(id, event.eventId);
    const document = JSON.stringify(event);
    if (prior) {
      if (prior.document !== document) throw new LabError('EVENT_ID_CONFLICT', 409);
      return { duplicate: true, revision: task.revision };
    }
    if (event.sequence <= task.lastSequence) throw new LabError('STALE_EVENT_SEQUENCE', 409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(id, event.eventId, document);
      task.lastSequence = event.sequence; task.fact = event; task.revision++; delete task.error;
      this.save(task); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { duplicate: false, revision: task.revision };
  }
  update(id: string, owner: string, instruction: string) {
    const task = this.owned(id, owner);
    if (task.status !== 'active') throw new LabError('TASK_PAUSED', 409);
    task.instruction = instruction; task.revision++; delete task.error;
    return this.save(task);
  }
  pause(id: string, owner: string) {
    const task = this.owned(id, owner); task.status = 'paused'; task.subscription = 'revoked';
    return this.save(task);
  }
  publish(snapshot: Task, output: unknown) {
    const task = this.task(snapshot.id);
    if (task.status !== 'active' || task.revision !== snapshot.revision) return false;
    task.output = this.definition(snapshot.agentId).validateOutput(snapshot, output);
    task.publishedFact = snapshot.fact;
    task.publishedRevision = snapshot.revision; delete task.error; this.save(task);
    return true;
  }
  fail(snapshot: Task) {
    const task = this.task(snapshot.id);
    if (task.revision === snapshot.revision && task.status === 'active') { task.error = this.definition(snapshot.agentId).errorCode; this.save(task); }
  }
  recordRun(run: Record<string, unknown> & { id: string; taskId: string }) {
    this.db.prepare('INSERT OR REPLACE INTO meeting_runs VALUES(?,?,?)').run(run.id, run.taskId, JSON.stringify(run));
  }
  runs(id: string) { return this.db.prepare('SELECT document FROM meeting_runs WHERE task_id=? ORDER BY rowid').all(id).map(r => JSON.parse(String(r.document))); }
  events(id: string) { return this.db.prepare('SELECT document FROM inbox WHERE task_id=? ORDER BY rowid').all(id).map(r => JSON.parse(String(r.document))); }
  interruptRuns() {
    for (const row of this.db.prepare('SELECT document FROM meeting_runs').all()) {
      const run = JSON.parse(String(row.document));
      if (run.status === 'running') this.recordRun({ ...run, status: 'interrupted', endedAt: stamp() });
    }
  }
  close() { this.db.close(); }
}
