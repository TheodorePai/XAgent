import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { randomUUID } from 'node:crypto';
import { TaskStore } from './store.js';
import type { Scope, Task } from './types.js';
import { taskView } from './view.js';

export class TaskRuntime {
  readonly agents = new Map<string, Agent>();
  private active = new Map<string, { owner: string; agentId: string; controller: AbortController; promise: Promise<void> }>();
  private closing = false;
  private timer: NodeJS.Timeout;
  constructor(readonly store: TaskStore, mastra: Mastra) {
    for (const definition of store.definitions.values()) {
      const agent = definition.createAgent();
      this.agents.set(definition.id, agent); mastra.addAgent(agent);
    }
    this.store.interruptRuns();
    this.timer = setInterval(() => this.pump(), 100); this.timer.unref();
  }
  private pump() {
    if (this.closing) return;
    for (const task of this.store.tasks()) {
      if (this.active.size >= 2) break;
      if (task.status !== 'active' || !task.fact || task.revision <= task.publishedRevision || task.error || this.active.has(task.id)) continue;
      if ([...this.active.values()].some(v => v.owner === task.ownerId)) continue;
      const limit = this.store.definition(task.agentId).limits?.concurrency || 2;
      if ([...this.active.values()].filter(v => v.agentId === task.agentId).length >= limit) continue;
      const controller = new AbortController();
      const promise = this.run(task, controller).finally(() => this.active.delete(task.id));
      this.active.set(task.id, { owner: task.ownerId, agentId: task.agentId, controller, promise });
    }
  }
  private async run(task: Task, controller: AbortController) {
    const id = randomUUID(), startedAt = new Date().toISOString(), t0 = Date.now();
    const value: Scope = { runId: id, task, trace: [] };
    const definition = this.store.definition(task.agentId), agent = this.agents.get(task.agentId)!;
    const record = { id, taskId: task.id, ownerId: task.ownerId, agentId: task.agentId, agentVersion: task.agentVersion,
      revision: task.revision, mode: task.mode, startedAt, trace: value.trace };
    this.store.recordRun({ ...record, status: 'running' });
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const requestContext = new RequestContext();
      cleanup = definition.prepareContext?.(requestContext, value);
      const result = await agent.generate(JSON.stringify(definition.prompt(task)),
        { runId: id, requestContext, maxSteps: definition.limits?.maxSteps || 5, modelSettings: { maxRetries: 0 },
          abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(definition.limits?.timeoutMs || 60000)]) });
      if (this.closing) return;
      if (result.finishReason !== 'stop' || !value.proposal) throw new Error('OUTPUT_NOT_SUBMITTED');
      const output = definition.validateOutput(task, value.proposal);
      // Retain mandatory A2UI Schema validation before either Agent publishes.
      taskView({ ...task, output, publishedFact: task.fact, publishedRevision: task.revision }, true, this.store.definitions);
      const published = this.store.publish(task, output);
      this.store.recordRun({ ...record, status: published ? 'completed' : 'superseded', mastraRunId: result.runId,
        endedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, usage: result.usage });
    } catch (error) {
      if (this.closing) return;
      this.store.fail(task);
      this.store.recordRun({ ...record, status: 'failed', error: definition.errorCode,
        errorType: error instanceof Error ? error.name : 'Error', endedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 });
    } finally {
      await cleanup?.(); await definition.afterRun?.(value);
    }
  }
  cancel(id: string) { this.active.get(id)?.controller.abort(); }
  async close() {
    this.closing = true; clearInterval(this.timer);
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map(r => r.promise));
  }
}
