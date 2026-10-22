import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraModelConfig } from '@mastra/core/llm';
import { z } from 'zod';
import { displayView } from '../tasks/view.js';

export const notesInputSchema = z.object({ mode: z.enum(['mock', 'deepseek']).default('mock'),
  notes: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(4000) }).strict()).max(20).default([]) });
export type NotesInput = z.infer<typeof notesInputSchema>;
type Binding = { runId: string; surfaceId: string; revision: number; instruction: string;
  trace: { tool: string; sourceIds?: string[] }[]; onResult: (output: Record<string, unknown>) => void };
export interface NotesRun<T extends NotesInput = NotesInput> {
  input: T; runId: string; instruction: string; surfaceId: string; revision: number; trace: Binding['trace'];
  searched?: boolean; baselineRead?: boolean; result?: Record<string, unknown>; closed: boolean;
  onResult?: Binding['onResult']; timer?: NodeJS.Timeout;
}
class NotesHolder { run?: NotesRun; binding?: Binding }
function holder(context: RequestContext<any>, id: string) {
  const key = `xagent.${id}.execution`, value = context.getRaw(key);
  if (value instanceof NotesHolder) return value;
  const created = new NotesHolder(); context.setRaw(key, created); return created;
}
export function bindNotesTask(context: RequestContext<any>, id: string, input: NotesInput, binding: Binding) {
  for (const [key, value] of Object.entries(input)) context.set(key, value);
  holder(context, id).binding = binding;
}
export function startNotesRun<T extends NotesInput>(context: RequestContext<any>, id: string, input: T, message: string, timeoutMs: number) {
  const state = holder(context, id), binding = state.binding;
  if (state.run && !state.run.closed) throw new Error('NOTES_CONTEXT_ALREADY_RUNNING');
  if (new Set(input.notes.map(n => n.id)).size !== input.notes.length) throw new Error('DUPLICATE_NOTE_IDS');
  const runId = binding?.runId ?? randomUUID();
  const run: NotesRun<T> = { input, runId, instruction: z.string().min(1).max(1000).parse(binding?.instruction ?? message),
    surfaceId: binding?.surfaceId ?? `${id}-preview-${runId}`, revision: binding?.revision ?? 1,
    trace: binding?.trace ?? [], onResult: binding?.onResult, closed: false };
  state.run = run;
  run.timer = setTimeout(() => { void closeNotesRun(context, id); }, timeoutMs + 1000); run.timer.unref();
  return run;
}
export function notesRun<T extends NotesInput>(context: RequestContext<any>, id: string): NotesRun<T> {
  const run = holder(context, id).run;
  if (!run || run.closed) throw new Error('NOTES_EXECUTION_NOT_ACTIVE');
  return run as NotesRun<T>;
}
export function closeNotesRun(context: RequestContext<any>, id: string) {
  const run = holder(context, id).run;
  if (run) { run.closed = true; clearTimeout(run.timer); }
  return Promise.resolve();
}
export function notesLifecycle(context: RequestContext<any>, id: string, timeoutMs: number) {
  holder(context, id);
  return { maxSteps: 8, modelSettings: { maxRetries: 0 }, abortSignal: AbortSignal.timeout(timeoutMs),
    onFinish: () => closeNotesRun(context, id), onError: () => closeNotesRun(context, id), onAbort: () => closeNotesRun(context, id) };
}
export function notesModel(mock: MastraModelConfig, context: RequestContext<any>): MastraModelConfig {
  if (z.enum(['mock', 'deepseek']).default('mock').parse(context.get('mode')) === 'mock') return mock;
  if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('DEEPSEEK_KEY_NOT_CONFIGURED');
  return { id: `deepseek/${process.env.DEEPSEEK_MODEL || 'deepseek-flash'}` as `${string}/${string}`,
    apiKey: process.env.DEEPSEEK_API_KEY, api: 'chat', url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1' };
}
export function searchRunNotes(run: NotesRun, query: string, tool: string) {
  run.searched = true;
  const terms = query.toLowerCase().split(/\s+/);
  const score = (text: string) => terms.filter(t => text.toLowerCase().includes(t)).length;
  const notes = [...run.input.notes].sort((a, b) => score(b.text) - score(a.text));
  run.trace.push({ tool, sourceIds: notes.map(n => n.id) });
  return { source: 'provided-reference-library', notes };
}
export function submitNotesResult(run: NotesRun, output: Record<string, unknown>, display: Parameters<typeof displayView>[2]) {
  const view = displayView(run.surfaceId, run.revision, display);
  run.result = output; run.onResult?.(output);
  return { accepted: true, artifact: { output, view } };
}
