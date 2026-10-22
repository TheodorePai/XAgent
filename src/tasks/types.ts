import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { z } from 'zod';

export interface TaskEvent { eventId: string; sequence: number; observedAt: string }
export interface Task {
  id: string; ownerId: string; agentId: string; agentVersion: string; mode: 'mock' | 'deepseek';
  name: string; instruction: string; notes: { id: string; text: string }[]; config?: Record<string, unknown>;
  status: 'active' | 'paused'; subscription: 'pending' | 'active' | 'revoked' | 'not_required'; deviceTokenHash: string;
  revision: number; publishedRevision: number; lastSequence: number; fact?: TaskEvent;
  output?: Record<string, unknown>; publishedFact?: TaskEvent;
  error?: string; createdAt: string; updatedAt: string;
}
export interface Scope {
  runId: string;
  task: Task; searched?: boolean; baselineRead?: boolean; proposal?: Record<string, unknown>;
  trace: { tool: string; sourceIds?: string[] }[];
}
export interface DefinitionContext {
  scope: (context: RequestContext) => Scope;
  model: ConstructorParameters<typeof Agent>[0]['model'];
}
export interface AgentDefinition {
  id: string; version: string; errorCode: string; surfacePrefix: string;
  subscription?: { watchTool: string; stopTool: string; eventType: string };
  initialEvent?(task: Task): TaskEvent;
  limits?: { maxSteps: number; timeoutMs: number; concurrency: number };
  afterRun?(scope: Scope): Promise<void>;
  configSchema: z.ZodType<Record<string, unknown>>;
  parseEvent(task: Task, input: unknown): TaskEvent;
  validateOutput(task: Task, input: unknown): Record<string, unknown>;
  createAgent(context: DefinitionContext): Agent;
  fixture(): MastraLanguageModelV2Mock;
  prompt(task: Task): unknown;
  display(task: Task): { title: string; summary: string; items: string[]; sourceIds: string[] };
  normalize?(task: Task): Task;
  project?(task: Task): Record<string, unknown>;
}
export type Registry = ReadonlyMap<string, AgentDefinition>;
