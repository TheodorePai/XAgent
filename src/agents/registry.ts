import type { Registry } from '../tasks/types.js';
import { meetingDefinition } from './meeting.js';
import { inspectionDefinition } from './inspection.js';
import { travelDefinition } from './travel.js';

export const definitions: Registry = new Map([
  [meetingDefinition.id, meetingDefinition],
  [inspectionDefinition.id, inspectionDefinition],
  [travelDefinition.id, travelDefinition],
]);
