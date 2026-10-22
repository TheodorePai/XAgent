import type { Scope } from './types.js';

export function searchNotes(scope: Scope, query: string, tool: string) {
  scope.searched = true;
  const terms = query.toLowerCase().split(/\s+/);
  const score = (text: string) => terms.filter(t => text.toLowerCase().includes(t)).length;
  const notes = [...scope.task.notes].sort((a, b) => score(b.text) - score(a.text));
  scope.trace.push({ tool, sourceIds: notes.map(n => n.id) });
  return { source: 'task-scoped-fixture-library', notes };
}
