import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { closeBrowser, type BrowserScope } from '../tools/browser.js';
type TravelContext = RequestContext<any>;

export const travelConfigSchema = z.object({ destination: z.string().min(1).max(80),
  days: z.number().int().min(1).max(7).default(3) }).strict();
export const travelContextSchema = z.object({ config: travelConfigSchema,
  mode: z.enum(['mock', 'deepseek']).default('mock') }).passthrough();
type TravelConfig = z.infer<typeof travelConfigSchema>;
type TaskBinding = { runId: string; surfaceId: string; revision: number; instruction: string;
  trace: BrowserScope['trace']; onResult: (output: Record<string, unknown>) => void };
export interface TravelRun extends BrowserScope {
  config: TravelConfig; instruction: string; surfaceId: string; revision: number;
  result?: Record<string, unknown>; onResult?: TaskBinding['onResult'];
  closed: boolean; timer?: NodeJS.Timeout; closing?: Promise<void>;
}

// Copies of RequestContext share this server-created object. JSON supplied by
// Studio cannot impersonate the class or provide a publication callback.
class TravelHolder { run?: TravelRun; binding?: TaskBinding }
const key = 'xagent.travel.execution';
function holder(context: TravelContext) {
  const value = context.getRaw(key);
  if (value instanceof TravelHolder) return value;
  const created = new TravelHolder(); context.setRaw(key, created); return created;
}
export function travelInput(context: TravelContext) {
  return travelContextSchema.parse({ config: context.get('config'), mode: context.get('mode') });
}
export function bindTravelTask(context: TravelContext, input: { config: unknown; mode: string }, binding: TaskBinding) {
  const parsed = travelContextSchema.parse(input);
  context.set('config', parsed.config); context.set('mode', parsed.mode);
  holder(context).binding = binding;
}
export function startTravelRun(context: TravelContext, message: string, timeoutMs: number) {
  const state = holder(context);
  if (state.run && !state.run.closed) throw new Error('TRAVEL_CONTEXT_ALREADY_RUNNING');
  const input = travelInput(context), binding = state.binding;
  const instruction = z.string().min(1).max(1000).parse(binding?.instruction ?? message);
  const runId = binding?.runId ?? randomUUID();
  const run: TravelRun = { runId, mode: input.mode, config: input.config, destination: input.config.destination,
    instruction, surfaceId: binding?.surfaceId ?? `travel-preview-${runId}`, revision: binding?.revision ?? 1,
    trace: binding?.trace ?? [], onResult: binding?.onResult, closed: false };
  state.run = run;
  // A bound in-flight operation may take time to observe cancellation. This
  // fallback also covers an SDK error before finish/error/abort callbacks run.
  run.timer = setTimeout(() => { void closeTravelRun(context); }, timeoutMs + 1000); run.timer.unref();
  return run;
}
export function travelRun(context: TravelContext) {
  const run = holder(context).run;
  if (!run || run.closed) throw new Error('TRAVEL_EXECUTION_NOT_ACTIVE');
  return run;
}
export function closeTravelRun(context: TravelContext): Promise<void> {
  const run = holder(context).run;
  if (!run) return Promise.resolve();
  if (!run.closing) {
    run.closed = true; clearTimeout(run.timer);
    run.closing = closeBrowser(run);
  }
  return run.closing;
}
export function travelLifecycle(context: TravelContext, timeoutMs: number) {
  // Allocate the holder before the SDK clones RequestContext. Inspection of an
  // Agent's default options does not start a run or create browser resources.
  holder(context);
  return { maxSteps: 10, modelSettings: { maxRetries: 0 }, abortSignal: AbortSignal.timeout(timeoutMs),
    onFinish: () => closeTravelRun(context), onError: () => closeTravelRun(context), onAbort: () => closeTravelRun(context) };
}
