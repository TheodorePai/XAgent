import { taskView } from '../tasks/view.js';
import { definitions } from '../agents/registry.js';
import { meetingDefinition } from '../agents/meeting.js';
import type { Task } from '../tasks/types.js';
export function meetingView(task: Task, initial: boolean) {
  return taskView(meetingDefinition.normalize!(task), initial, definitions);
}
