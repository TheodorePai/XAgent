import { randomUUID } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

// Scripted policies exercise Mastra's actual loop; they do not evaluate an LLM.
export function scriptedModel(id: string, decide: (input: any, results: Map<string, any>) => { tool?: string; args?: object }) {
  return new MastraLanguageModelV2Mock({ provider: 'xagent-test-fixture', modelId: id,
    doGenerate: async options => {
      const user = options.prompt.find(m => m.role === 'user');
      const content = user?.content;
      const text = typeof content === 'string' ? content : content?.filter(p => p.type === 'text').map(p => p.text).join('');
      const results = new Map();
      for (const part of options.prompt.flatMap(m => m.role === 'tool' ? m.content : []).filter(p => p.type === 'tool-result')) {
        if (part.output.type === 'json') results.set(part.toolName, part.output.value);
        else if (part.output.type === 'text') { try { results.set(part.toolName, JSON.parse(part.output.value)); } catch { /* tool error */ } }
      }
      const { tool, args } = decide(JSON.parse(text || '{}'), results);
      return { content: tool ? [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: tool, input: JSON.stringify(args || {}) }]
        : [{ type: 'text' as const, text: '[MOCK] 已提交结果。' }],
        finishReason: tool ? 'tool-calls' as const : 'stop' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
    } });
}
