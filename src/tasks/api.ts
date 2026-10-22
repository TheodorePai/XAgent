import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { LabError } from '../store.js';
import { createTaskSchema, TaskStore } from './store.js';
import { TaskRuntime } from './runtime.js';
import { taskView } from './view.js';

export async function taskApi(req: IncomingMessage, url: URL, body: () => Promise<unknown>,
  reply: (status: number, value: unknown) => void, store: TaskStore, runtime: TaskRuntime) {
  const path = url.pathname;
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] || '';
  const device = path.match(/^\/v1\/device\/tasks\/([0-9a-f-]{36})\/(commands|ack|events)$/);
  if (device) {
    const task = store.device(device[1], token);
    const subscription = store.definition(task.agentId).subscription!;
    if (req.method === 'GET' && device[2] === 'commands') {
      reply(200, { simulated: true, commands: [{ commandId: task.id, subscriptionId: task.id,
        tool: task.status === 'paused' ? subscription.stopTool : subscription.watchTool,
        state: task.subscription, eventType: subscription.eventType, filter: { ...task.config, taskId: task.id } }] }); return;
    }
    if (req.method === 'POST' && device[2] === 'ack') {
      z.object({ commandId: z.literal(task.id) }).strict().parse(await body());
      const updated = store.ack(task.id, token); reply(200, { subscription: updated.subscription }); return;
    }
    if (req.method === 'POST' && device[2] === 'events') {
      const result = store.receive(task.id, token, await body());
      reply(202, result); return;
    }
    throw new LabError('NOT_FOUND', 404);
  }
  const owner = store.authenticate(token);
  if (req.method === 'GET' && path === '/v1/tasks') {
    reply(200, { tasks: store.tasks().filter(t => t.ownerId === owner).map(t => store.public(t)) }); return;
  }
  if (req.method === 'POST' && path === '/v1/tasks') {
    const input = createTaskSchema.parse(await body());
    if (input.mode === 'deepseek' && !process.env.DEEPSEEK_API_KEY?.trim()) throw new LabError('DEEPSEEK_KEY_NOT_CONFIGURED', 412);
    reply(201, store.create(owner, input)); return;
  }
  const match = path.match(/^\/v1\/tasks\/([0-9a-f-]{36})(?:\/(instruction|pause|view))?$/);
  if (match) {
    const task = store.owned(match[1], owner);
    if (req.method === 'GET' && !match[2]) {
      reply(200, { ...store.public(task), events: store.events(task.id), runs: store.runs(task.id) }); return;
    }
    if (req.method === 'POST' && match[2] === 'instruction') {
      const input = z.object({ instruction: z.string().min(1).max(1000) }).strict().parse(await body());
      reply(202, store.public(store.update(task.id, owner, input.instruction))); return;
    }
    if (req.method === 'POST' && match[2] === 'pause') {
      z.object({}).strict().parse(await body());
      const updated = store.pause(task.id, owner); runtime.cancel(task.id);
      reply(200, store.public(updated)); return;
    }
    if (req.method === 'GET' && match[2] === 'view') {
      const after = z.coerce.number().int().min(0).max(task.publishedRevision).parse(url.searchParams.get('after') || 0);
      reply(200, after === task.publishedRevision ? { publishedRevision: after, messages: [] } : taskView(task, after === 0, store.definitions)); return;
    }
  }
  throw new LabError('NOT_FOUND', 404);
}
