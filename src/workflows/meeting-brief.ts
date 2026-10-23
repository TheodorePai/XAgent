import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { briefSchema, createMeetingAgent, eventSchema, validateBrief } from '../agents/meeting.js';
import { executionModeSchema } from '../agents/model.js';
import { notesInputSchema } from '../agents/notes-context.js';
import type { ExecutionGuard } from '../mastra/operations.js';
import { displayView } from '../tasks/view.js';
import { WorkflowLifecycle } from './lifecycle.js';

export const meetingWorkflowInputSchema = z.object({ meeting: eventSchema.shape.meeting,
  notes: notesInputSchema.shape.notes, mode: executionModeSchema,
  instruction: z.string().min(1).max(1000) }).strict();
const draftSchema = meetingWorkflowInputSchema.extend({ brief: briefSchema, text: z.string().min(1),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), totalTokens: z.number().optional() }) });
const submissionSchema = z.object({ accepted: z.literal(true), artifact: z.object({ output: briefSchema }) });
export const meetingWorkflowOutputSchema = z.object({ accepted: z.literal(true),
  artifact: z.object({ output: briefSchema, view: z.object({ publishedRevision: z.number().int(), surfaceId: z.string(),
    protocol: z.literal('v0.9.1'), messages: z.array(z.record(z.string(), z.unknown())).length(3) }) }),
  text: z.string().min(1), usage: draftSchema.shape.usage, mode: z.enum(['mock', 'deepseek']) });

/** Stateless Agent factory reuse; workflow storage is owned by its Mastra instance. */
export function createMeetingBriefWorkflow(options: { agent?: Agent; guard?: ExecutionGuard } = {}) {
  const agent = options.agent ?? createMeetingAgent(), lifecycle = new WorkflowLifecycle(options.guard);
  const prepare = createStep({ id: 'prepare-meeting', description: '校验会议、授权资料和用户要求',
    inputSchema: meetingWorkflowInputSchema, outputSchema: meetingWorkflowInputSchema,
    execute: ({ inputData, runId, abortSignal }) => lifecycle.step(runId, abortSignal, async () => {
      const input = meetingWorkflowInputSchema.parse(inputData);
      if (new Set(input.notes.map(note => note.id)).size !== input.notes.length) throw new Error('DUPLICATE_NOTE_IDS');
      return input;
    }) });
  const draft = createStep({ id: 'draft-with-agent', description: '复用现有参会 Agent 检索资料并生成简报',
    inputSchema: meetingWorkflowInputSchema, outputSchema: draftSchema,
    execute: ({ inputData, runId, abortSignal }) => lifecycle.step(runId, abortSignal, async () => {
      const requestContext = new RequestContext(Object.entries({ mode: inputData.mode, meeting: inputData.meeting, notes: inputData.notes }));
      const result = await agent.generate(inputData.instruction, { requestContext, abortSignal });
      const submitted = submissionSchema.safeParse(result.toolResults.findLast(tool => tool.payload.toolName === 'submitBrief')?.payload.result);
      if (result.finishReason !== 'stop' || !submitted.success) throw new Error('WORKFLOW_BRIEF_NOT_SUBMITTED');
      return { ...inputData, brief: validateBrief(inputData.notes, submitted.data.artifact.output), text: result.text, usage: result.usage };
    }) });
  const validate = createStep({ id: 'validate-brief', description: '复核来源与业务结果，再执行 A2UI Schema 校验',
    inputSchema: draftSchema, outputSchema: meetingWorkflowOutputSchema,
    execute: ({ inputData, runId, abortSignal }) => lifecycle.step(runId, abortSignal, async () => {
      const output = validateBrief(inputData.notes, inputData.brief);
      const view = displayView(`workflow-${runId}`, 1, { title: inputData.meeting.title, summary: output.summary,
        items: output.checklist, sourceIds: output.sourceIds });
      return meetingWorkflowOutputSchema.parse({ accepted: true, artifact: { output, view }, text: inputData.text, usage: inputData.usage, mode: inputData.mode });
    }) });
  return createWorkflow({ id: 'meeting-brief', description: '参会简报示例：校验输入 → 参会 Agent → 来源及产物校验',
    inputSchema: meetingWorkflowInputSchema, outputSchema: meetingWorkflowOutputSchema,
    retryConfig: { attempts: 0, delay: 0 },
    options: { autoRestartActiveRuns: false, onStart: ({ runId, getInitData }) => {
      meetingWorkflowInputSchema.parse(getInitData()); lifecycle.start(runId);
    }, onFinish: ({ runId }) => lifecycle.finish(runId), onError: ({ runId }) => lifecycle.finish(runId) },
  }).then(prepare).then(draft).then(validate).commit();
}
