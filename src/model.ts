import { randomUUID } from 'node:crypto';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

// This is deliberately a scripted model, not an LLM. It exercises Mastra's real
// tool loop without a key or network request. It must never be presented as an
// evaluation of DeepSeek's reasoning or tool selection.
export function fixtureModel() {
  return new MastraLanguageModelV2Mock({
    provider: 'xagent-test-fixture', modelId: 'scripted-device-v1',
    doGenerate: async options => {
      const results = options.prompt.flatMap(message => message.role === 'tool' ? message.content : [])
        .filter(part => part.type === 'tool-result');
      const value = (name: string): Record<string, unknown> | undefined => {
        const result = results.find(part => part.toolName === name);
        if (!result) return undefined;
        const output = result.output;
        if (output.type === 'json' && output.value && typeof output.value === 'object') return output.value as Record<string, unknown>;
        if (output.type === 'text') { try { return JSON.parse(output.value); } catch { return undefined; } }
        return undefined;
      };
      const photo = options.prompt.some(message => message.role === 'user' && JSON.stringify(message.content).includes('[scenario:photo]'));
      const battery = value('readBattery'), calendar = value('queryCalendar'), image = value('capturePhoto');
      const failure = [battery, calendar, image].find(result => result?.status === 'failed');
      let tool: string | undefined;
      let text = '';
      if (failure) text = `[MOCK] 手机工具失败：${failure.error}。没有把失败解释为查询结果。`;
      else if (photo) {
        if (!image) tool = 'capturePhoto';
        else text = `[MOCK] 已收到手机拍照结果：${JSON.stringify(image.data)}。继续决策完成。`;
      } else if (!battery) tool = 'readBattery';
      else {
        const level = Number((battery.data as Record<string, unknown>)?.level);
        if (level < 20) text = `[MOCK] 手机实际返回电量 ${level}%，建议先充电；没有继续查询日历。`;
        else if (!calendar) tool = 'queryCalendar';
        else text = `[MOCK] 手机实际返回电量 ${level}%；日历结果 ${JSON.stringify(calendar.data)}。已根据两个工具结果完成决策。`;
      }
      return {
        content: tool ? [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: tool, input: '{}' }]
          : [{ type: 'text' as const, text }],
        finishReason: tool ? 'tool-calls' as const : 'stop' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [],
      };
    },
  });
}
