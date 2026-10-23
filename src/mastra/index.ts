import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { createTravelAgent } from '../agents/travel.js';
import { createMeetingAgent } from '../agents/meeting.js';
import { createInspectionAgent } from '../agents/inspection.js';
import { registerApiRoute } from '@mastra/core/server';
import { StudioGate, studioBuildInfo } from './operations.js';
import { resolveMode } from '../agents/model.js';
import { createReferenceAgent } from '../agents/reference.js';
import { createMeetingBriefWorkflow } from '../workflows/meeting-brief.js';

// Studio has its own storage and never starts TaskRuntime or opens the task DB.
process.env.XAGENT_DEFAULT_MODE ??= 'deepseek';
const defaultMode = resolveMode();
const directory = resolve(process.env.STUDIO_DATA_DIR || './data/studio');
mkdirSync(directory, { recursive: true });
function memory() { return new Memory({ options: {
    lastMessages: 10, semanticRecall: false, workingMemory: { enabled: false }, generateTitle: false,
  } }); }
const guard = new StudioGate(), build = studioBuildInfo();
const agents = { travelAgent: createTravelAgent({ memory: memory(), guard }),
    meetingAgent: createMeetingAgent({ memory: memory(), guard }),
    inspectionAgent: createInspectionAgent({ memory: memory(), guard }),
    referenceAgent: createReferenceAgent({ memory: memory(), guard }) };
const workflows = { 'meeting-brief': createMeetingBriefWorkflow({ guard }) };
export const mastra = new Mastra({ agents, workflows,
  storage: new LibSQLStore({ id: 'studio-storage', url: 'file:' + join(directory, 'mastra.db').replaceAll('\\', '/') }),
  server: { host: '127.0.0.1', port: Number(process.env.STUDIO_PORT || 4111), apiRoutes: [
    registerApiRoute('/xagent/status', { method: 'GET', handler: c => c.json({ service: 'xagent-studio', build,
      ...guard.status(), defaultMode, capabilities: { agents: Object.values(agents).map(agent => agent.id), workflows: Object.keys(workflows) },
      deepseekConfigured: !!process.env.DEEPSEEK_API_KEY?.trim() }) }),
  ] },
});
