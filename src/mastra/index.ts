import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { createTravelAgent } from '../agents/travel.js';
import { createMeetingAgent } from '../agents/meeting.js';
import { createInspectionAgent } from '../agents/inspection.js';

// Studio has its own storage and never starts TaskRuntime or opens the task DB.
const directory = resolve(process.env.STUDIO_DATA_DIR || './data/studio');
mkdirSync(directory, { recursive: true });
function memory() { return new Memory({ options: {
    lastMessages: 10, semanticRecall: false, workingMemory: { enabled: false }, generateTitle: false,
  } }); }
export const mastra = new Mastra({
  agents: { travelAgent: createTravelAgent({ memory: memory() }),
    meetingAgent: createMeetingAgent({ memory: memory() }),
    inspectionAgent: createInspectionAgent({ memory: memory() }) },
  storage: new LibSQLStore({ id: 'studio-storage', url: 'file:' + join(directory, 'mastra.db').replaceAll('\\', '/') }),
  server: { host: '127.0.0.1', port: Number(process.env.STUDIO_PORT || 4111) },
});
