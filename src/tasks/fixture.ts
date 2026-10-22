import { randomUUID } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

// Scripted policies exercise Mastra's actual loop; they do not evaluate an LLM.
export function scriptedModel(id: string, decide: (input: any, results: Map<string, any>) => { tool?: string; args?: object; text?: string }) {
  const next = (options: any) => {
      const user = options.prompt.findLast((m: any) => m.role === 'user');
      const content = user?.content;
      const text = typeof content === 'string' ? content : content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
      const results = new Map();
      for (const part of options.prompt.flatMap((m: any) => m.role === 'tool' ? m.content : []).filter((p: any) => p.type === 'tool-result')) {
        if (part.output.type === 'json') results.set(part.toolName, part.output.value);
        else if (part.output.type === 'text') { try { results.set(part.toolName, JSON.parse(part.output.value)); } catch { /* tool error */ } }
      }
      const system = options.prompt.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
      const supplied = system.split('\n').findLast((line: string) => line.startsWith('XAGENT_INPUT_JSON='));
      const input = JSON.parse(supplied ? supplied.slice('XAGENT_INPUT_JSON='.length) : text || '{}');
      return decide(input, results);
  };
  return new MastraLanguageModelV2Mock({ provider: 'xagent-test-fixture', modelId: id,
    doGenerate: async options => {
      const { tool, args, text: reply } = next(options);
      return { content: tool ? [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: tool, input: JSON.stringify(args || {}) }]
        : [{ type: 'text' as const, text: reply ?? '[MOCK] 已提交结果。' }],
        finishReason: tool ? 'tool-calls' as const : 'stop' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
    },
    doStream: async options => {
      const { tool, args, text: reply } = next(options), callId = randomUUID();
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        if (tool) {
          const input = JSON.stringify(args || {});
          controller.enqueue({ type: 'tool-input-start', id: callId, toolName: tool });
          controller.enqueue({ type: 'tool-input-delta', id: callId, delta: input });
          controller.enqueue({ type: 'tool-input-end', id: callId });
          controller.enqueue({ type: 'tool-call', toolCallId: callId, toolName: tool, input });
        } else {
          controller.enqueue({ type: 'text-start', id: callId });
          controller.enqueue({ type: 'text-delta', id: callId, delta: reply ?? '[MOCK] 已提交结果。' });
          controller.enqueue({ type: 'text-end', id: callId });
        }
        controller.enqueue({ type: 'finish', finishReason: tool ? 'tool-calls' : 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
        controller.close();
      } }) };
    } });
}
