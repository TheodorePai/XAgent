import type { ExecutionGuard } from '../mastra/operations.js';

/** A ticket spans the whole workflow, including gaps between steps. */
export class WorkflowLifecycle {
  private runs = new Map<string, { release?: () => void; activeSteps: number; terminal: boolean }>();
  constructor(private readonly guard?: ExecutionGuard) {}
  start(runId: string) {
    if (this.runs.has(runId)) throw new Error('WORKFLOW_ALREADY_RUNNING');
    this.runs.set(runId, { release: this.guard?.enter(), activeSteps: 0, terminal: false });
  }
  async step<T>(runId: string, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    // Resume/restart may enter a step without onStart; it must pass admission too.
    if (!this.runs.has(runId)) this.start(runId);
    const run = this.runs.get(runId)!;
    if (run.terminal) throw new Error('WORKFLOW_ALREADY_FINISHED');
    run.activeSteps++;
    try { return await execute(); }
    finally { run.activeSteps--; this.releaseIfDone(runId); }
  }
  finish(runId: string) {
    const run = this.runs.get(runId);
    if (run) { run.terminal = true; this.releaseIfDone(runId); }
  }
  private releaseIfDone(runId: string) {
    const run = this.runs.get(runId);
    // Cancellation can be reported before an in-flight Agent observes its signal.
    if (run?.terminal && run.activeSteps === 0) { run.release?.(); this.runs.delete(runId); }
  }
}
