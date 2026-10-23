import type { MastraModelConfig } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

const modeSchema = z.enum(['mock', 'deepseek']);

/** Request overrides deployment default; task adapters always supply their saved mode. */
export function resolveMode(value?: unknown) {
  return modeSchema.parse(value === undefined ? process.env.XAGENT_DEFAULT_MODE ?? 'mock' : value);
}

// Lazy default keeps input validation and model metadata on the same deployment setting.
export const executionModeSchema = modeSchema.default(() => resolveMode());

export function resolveModel(mock: MastraModelConfig, context: RequestContext<any>): MastraModelConfig {
  if (resolveMode(context.get('mode')) === 'mock') return mock;
  if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('DEEPSEEK_KEY_NOT_CONFIGURED');
  return { id: `deepseek/${process.env.DEEPSEEK_MODEL || 'deepseek-flash'}` as `${string}/${string}`,
    apiKey: process.env.DEEPSEEK_API_KEY, api: 'chat', url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1' };
}
