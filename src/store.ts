import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Mode = 'mock' | 'deepseek';
export type ToolName = 'readBattery' | 'queryCalendar' | 'capturePhoto';
export type RunStatus = 'running' | 'waiting_device' | 'completed' | 'failed' | 'canceled';
export interface Run {
  id: string; mode: Mode; scenario: 'plan' | 'photo'; prompt: string;
  status: RunStatus; mastraRunId?: string; waitingCallId?: string; text: string; error?: string;
  createdAt: string; updatedAt: string; jobTtlMs: number;
}
export interface DeviceJob {
  id: string; runId: string; deviceId: string; tool: ToolName;
  status: 'pending' | 'completed' | 'canceled' | 'expired';
  createdAt: string; expiresAt: string; result?: Record<string, unknown>;
}
export class LabError extends Error {
  constructor(public code: string, public httpStatus: number) { super(code); }
}

// The broker's ledger is separate from Mastra's snapshots: transport receipt and
// agent execution are two different lifecycles. No model credential is stored here.
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'device-ledger.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
        tool TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(run_id, tool));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, document TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  run(id: string): Run | undefined {
    const row = this.db.prepare('SELECT document FROM runs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.document)) : undefined;
  }
  runs(): Run[] { return this.db.prepare('SELECT document FROM runs').all().map(r => JSON.parse(String(r.document))); }
  create(mode: Mode, scenario: Run['scenario'], prompt: string, jobTtlMs = 120000): Run {
    const at = new Date().toISOString();
    const run: Run = { id: randomUUID(), mode, scenario, prompt, jobTtlMs, status: 'running', text: '', createdAt: at, updatedAt: at };
    this.db.prepare('INSERT INTO runs VALUES (?,?)').run(run.id, JSON.stringify(run));
    this.event(run.id, 'run.created', { mode, scenario });
    return run;
  }
  patch(id: string, patch: Partial<Run>): Run {
    const previous = this.run(id);
    if (!previous) throw new LabError('RUN_NOT_FOUND', 404);
    if (['canceled', 'failed', 'completed'].includes(previous.status)) return previous;
    const run = { ...previous, ...patch, id, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE runs SET document=? WHERE id=?').run(JSON.stringify(run), id);
    if (previous.status !== run.status) this.event(id, 'run.' + run.status, {});
    return run;
  }
  job(id: string): DeviceJob | undefined {
    const row = this.db.prepare('SELECT document FROM jobs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.document)) : undefined;
  }
  jobs(runId?: string): DeviceJob[] {
    const rows = runId ? this.db.prepare('SELECT document FROM jobs WHERE run_id=? ORDER BY rowid').all(runId)
      : this.db.prepare('SELECT document FROM jobs ORDER BY rowid').all();
    return rows.map(r => JSON.parse(String(r.document)));
  }
  request(runId: string, tool: ToolName, ttlMs: number): DeviceJob {
    const run = this.run(runId);
    if (!run || !['running', 'waiting_device'].includes(run.status)) throw new LabError('RUN_INACTIVE', 409);
    const previous = this.jobs(runId).find(j => j.tool === tool);
    if (previous) return previous;
    const job: DeviceJob = { id: randomUUID(), runId, deviceId: 'sim-phone', tool, status: 'pending',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    this.writeJob(job);
    this.event(runId, 'device.requested', { callId: job.id, tool });
    return job;
  }
  private writeJob(job: DeviceJob) {
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
      .run(job.id, job.runId, job.tool, JSON.stringify(job));
  }
  receive(id: string, result: Record<string, unknown>): { job: DeviceJob; duplicate: boolean } {
    const job = this.job(id);
    if (!job) throw new LabError('CALL_NOT_FOUND', 404);
    // An identical retry is a receipt read, even if its run already completed.
    if (job.status === 'completed') {
      if (JSON.stringify(job.result) !== JSON.stringify(result)) throw new LabError('RESULT_CONFLICT', 409);
      return { job, duplicate: true };
    }
    const run = this.run(job.runId);
    if (!run || !['running', 'waiting_device'].includes(run.status) || job.status !== 'pending') throw new LabError('CALL_INACTIVE', 410);
    if (Date.parse(job.expiresAt) <= Date.now()) {
      this.writeJob({ ...job, status: 'expired' });
      this.patch(job.runId, { status: 'failed', error: 'DEVICE_TIMEOUT' });
      this.event(job.runId, 'device.expired', { callId: id });
      throw new LabError('CALL_EXPIRED', 410);
    }
    const completed = { ...job, status: 'completed' as const, result };
    this.writeJob(completed);
    this.event(job.runId, 'device.result', { callId: id, tool: job.tool });
    return { job: completed, duplicate: false };
  }
  cancel(id: string): Run {
    const run = this.run(id);
    if (!run) throw new LabError('RUN_NOT_FOUND', 404);
    if (['completed', 'failed', 'canceled'].includes(run.status)) return run;
    // Commit the terminal decision before aborting any live execution.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.patch(id, { status: 'canceled' });
      for (const job of this.jobs(id).filter(j => j.status === 'pending')) this.writeJob({ ...job, status: 'canceled' });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.run(id)!;
  }
  expire(): void {
    for (const job of this.jobs().filter(j => j.status === 'pending' && Date.parse(j.expiresAt) <= Date.now())) {
      this.writeJob({ ...job, status: 'expired' });
      this.patch(job.runId, { status: 'failed', error: 'DEVICE_TIMEOUT' });
      this.event(job.runId, 'device.expired', { callId: job.id });
    }
  }
  event(runId: string, type: string, data: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events(run_id,at,type,document) VALUES (?,?,?,?)')
      .run(runId, new Date().toISOString(), type, JSON.stringify(data));
  }
  events(id: string) {
    return this.db.prepare('SELECT seq,at,type,document FROM events WHERE run_id=? ORDER BY seq').all(id)
      .map(({ document, ...event }) => ({ ...event, data: JSON.parse(String(document)) }));
  }
}
