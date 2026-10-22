import { TaskRuntime } from '../tasks/runtime.js';
export class MeetingRuntime extends TaskRuntime {
  get agent() { return this.agents.get('meeting-prep')!; }
}
