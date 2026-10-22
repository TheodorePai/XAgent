import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Registry, Task } from './types.js';

// Official schemas pinned in REVISION; catalog.json is the selected Basic catalog.
const base = new URL('../../docs/vendor/a2ui/', import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, base), 'utf8').replace(/^\uFEFF/, ''));
const catalog = read('catalog.json');
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(read('common_types.json'));
ajv.addSchema(catalog, 'https://a2ui.org/specification/v0_9/catalog.json');
const validate = ajv.compile(read('server_to_client.json'));

export function taskView(task: Task, initial: boolean, definitions: Registry) {
  if (!task.output || !task.fact || !task.publishedRevision) return { publishedRevision: 0, messages: [] };
  const definition = definitions.get(task.agentId);
  if (!definition) throw new Error('UNKNOWN_AGENT');
  const display = definition.display(task);
  const surfaceId = `${definition.surfacePrefix}-${task.id}`;
  const version = 'v0.9.1';
  // Fixed binding tree: future revisions replace the model, never add stale rows.
  const components = [
    { id: 'root', component: 'Column', children: ['title', 'summary', 'checklist', 'sources'] },
    { id: 'title', component: 'Text', text: { path: '/title' }, variant: 'h2' },
    { id: 'summary', component: 'Text', text: { path: '/summary' } },
    { id: 'checklist', component: 'Text', text: { path: '/checklist' } },
    { id: 'sources', component: 'Text', text: { path: '/sources' }, variant: 'caption' },
  ];
  const messages: object[] = initial ? [
    { version, createSurface: { surfaceId, catalogId: catalog.catalogId } },
    { version, updateComponents: { surfaceId, components } },
  ] : [];
  messages.push({ version, updateDataModel: { surfaceId, path: '/', value: {
    title: display.title, summary: display.summary,
    checklist: display.items.map((v, i) => `${i + 1}. ${v}`).join('\n'),
    sources: display.sourceIds.join(', '), revision: task.publishedRevision,
  } } });
  for (const message of messages) if (!validate(message)) throw new Error('A2UI_SCHEMA_INVALID');
  return { publishedRevision: task.publishedRevision, surfaceId, protocol: version, messages };
}
