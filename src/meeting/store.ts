// Compatibility imports for the first experiment and its persisted callback helper.
import { TaskStore } from '../tasks/store.js';
import type { Task as SharedTask } from '../tasks/types.js';
import { definitions } from '../agents/registry.js';
import type { Brief, MeetingEvent } from '../agents/meeting.js';
export { briefSchema, eventSchema } from '../agents/meeting.js';
export { createTaskSchema } from '../tasks/store.js';
export type { Brief, MeetingEvent } from '../agents/meeting.js';
export type Task = SharedTask & { brief?: Brief; briefMeeting?: MeetingEvent['meeting'] };
export class MeetingStore extends TaskStore {
  constructor(directory: string) { super(directory, definitions); }
  override task(id: string): Task {
    const task = super.task(id);
    return { ...task, ...this.definition(task.agentId).project?.(task) };
  }
}
