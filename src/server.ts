import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Engine } from './engine.js';
import { Store, LabError, type DeviceJob } from './store.js';
import { TaskStore } from './tasks/store.js';
import { TaskRuntime } from './tasks/runtime.js';
import { taskApi } from './tasks/api.js';
import { definitions } from './agents/registry.js';

const directory = resolve(process.env.DATA_DIR || './data');
const store = new Store(directory);
const engine = new Engine(store, directory);
await engine.init();
const taskStore = new TaskStore(directory, definitions);
const taskRuntime = new TaskRuntime(taskStore, engine.mastra);

const createInput = z.object({ mode: z.enum(['mock', 'deepseek']).default('mock'),
  scenario: z.enum(['plan', 'photo']).default('plan'), prompt: z.string().trim().min(1).max(2000).optional(),
  jobTtlMs: z.number().int().min(100).max(300000).default(120000) }).strict();
const observedAt = z.iso.datetime({ offset: true });
const successSchemas = {
  readBattery: z.object({ level: z.number().int().min(0).max(100), charging: z.boolean() }).strict(),
  queryCalendar: z.object({ events: z.array(z.object({ title: z.string().max(200), startAt: z.iso.datetime({ offset: true }) }).strict()).max(20) }).strict(),
  capturePhoto: z.object({ description: z.string().min(1).max(2000), simulated: z.literal(true) }).strict(),
};
function resultFor(job: DeviceJob, input: unknown): Record<string, unknown> {
  const envelope = z.object({ status: z.enum(['succeeded', 'failed']), observedAt,
    data: z.unknown().optional(), error: z.enum(['permission_denied', 'device_unavailable', 'user_canceled']).optional() }).strict().parse(input);
  const age = Date.now() - Date.parse(envelope.observedAt);
  if (job.status !== 'completed' && (age < -60000 || age > 300000)) throw new LabError('STALE_DEVICE_OBSERVATION', 400);
  if (envelope.status === 'failed') {
    if (!envelope.error || envelope.data !== undefined) throw new LabError('INVALID_FAILURE_RESULT', 400);
    return { status: envelope.status, observedAt: envelope.observedAt, error: envelope.error };
  }
  if (envelope.error) throw new LabError('INVALID_SUCCESS_RESULT', 400);
  return { status: envelope.status, observedAt: envelope.observedAt, data: successSchemas[job.tool].parse(envelope.data) };
}
const server = createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  try {
    // The legacy /runs experiment trusts loopback. /v1 adds demo scoped auth;
    // both remain behind loopback / SSH forwarding, not a public service.
    if (req.headers.origin) throw new LabError('BROWSER_ORIGIN_NOT_ALLOWED', 403);
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const body = async () => {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) throw new LabError('BODY_TOO_LARGE', 413);
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new LabError('INVALID_JSON', 400); }
    };
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      reply(200, { service: 'xagent-mastra-device-lab', mastra: '1.78.0', defaultMode: 'mock',
        mockIsScripted: true, deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
        persistentStorage: true, simulatedDeviceOnly: true, meetingAgent: true, agentIds: [...definitions.keys()], pid: process.pid }); return;
    }
    if (path.startsWith('/v1/')) {
      await taskApi(req, url, body, reply, taskStore, taskRuntime); return;
    }
    if (req.method === 'POST' && path === '/runs') {
      const input = createInput.parse(await body());
      if (input.mode === 'deepseek' && !process.env.DEEPSEEK_API_KEY?.trim()) throw new LabError('DEEPSEEK_KEY_NOT_CONFIGURED', 412);
      const run = store.create(input.mode, input.scenario, input.prompt || (input.scenario === 'photo' ? '请拍照后告诉我现场情况。' : '请根据手机电量和日历规划接下来的安排。'), input.jobTtlMs);
      engine.enqueue(run.id); reply(202, run); return;
    }
    if (req.method === 'GET' && path === '/runs') { reply(200, { runs: store.runs() }); return; }
    const runMatch = path.match(/^\/runs\/([0-9a-f-]{36})(\/cancel)?$/);
    if (runMatch) {
      if (req.method === 'POST' && runMatch[2]) { reply(200, engine.cancel(runMatch[1])); return; }
      const run = store.run(runMatch[1]);
      if (!run) throw new LabError('RUN_NOT_FOUND', 404);
      if (req.method === 'GET' && !runMatch[2]) {
        reply(200, { ...run, jobs: store.jobs(run.id), events: store.events(run.id) }); return;
      }
    }
    if (req.method === 'GET' && path === '/devices/sim-phone/commands') {
      reply(200, { commands: store.jobs().filter(j => j.status === 'pending' &&
        ['running', 'waiting_device'].includes(store.run(j.runId)?.status || '')) }); return;
    }
    const resultMatch = path.match(/^\/devices\/sim-phone\/results\/([0-9a-f-]{36})$/);
    if (req.method === 'POST' && resultMatch) {
      const job = store.job(resultMatch[1]);
      if (!job) throw new LabError('CALL_NOT_FOUND', 404);
      const received = store.receive(job.id, resultFor(job, await body()));
      if (store.run(job.runId)?.status === 'waiting_device') engine.enqueue(job.runId, job.id);
      reply(200, { accepted: true, callId: job.id, duplicate: received.duplicate }); return;
    }
    throw new LabError('NOT_FOUND', 404);
  } catch (error) {
    if (error instanceof z.ZodError) reply(400, { error: 'INVALID_INPUT', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    else if (error instanceof LabError) reply(error.httpStatus, { error: error.code });
    else reply(500, { error: 'INTERNAL_ERROR' });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
const tick = setInterval(() => store.expire(), 250); tick.unref();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4391);
server.listen(port, host, () => console.log(JSON.stringify({ event: 'listening', host, port: (server.address() as { port: number }).port, mode: 'mock-default', deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()) })));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  clearInterval(tick); server.close();
  await taskRuntime.close(); taskStore.close();
  await engine.close(); store.close();
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
