import { ModelError, validateProject, type ProjectDoc } from '@netlab/engine';

const FORMAT = 'netlab-selection';
const VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;

export function selectionProject(source: ProjectDoc, selected: string[]): ProjectDoc {
  const ids = new Set(selected);
  const deviceIds = new Set(source.devices.filter((d) => ids.has(d.id)).map((d) => d.id));
  for (const link of source.links) {
    if (ids.has(link.id)) {
      deviceIds.add(link.a.device);
      deviceIds.add(link.b.device);
    }
  }
  const devices = source.devices.filter((d) => deviceIds.has(d.id));
  const included = new Set(devices.map((d) => d.id));
  const fragment: ProjectDoc = {
    ...source,
    name: 'Selection',
    devices,
    links: source.links.filter((l) => included.has(l.a.device) && included.has(l.b.device)),
    notes: source.notes.filter((n) => ids.has(n.id)),
    zones: source.zones.filter((z) => ids.has(z.id)),
  };
  if (!fragment.devices.length && !fragment.notes.length && !fragment.zones.length) {
    throw new ModelError('empty_selection', 'Select devices or annotations to copy');
  }
  return fragment;
}

export function encodeSelection(source: ProjectDoc, selected: string[]): string {
  const text = JSON.stringify({ format: FORMAT, version: VERSION, project: selectionProject(source, selected) });
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new ModelError('selection_too_large', 'Selection is too large to copy');
  return text;
}

export function decodeSelection(text: string): ProjectDoc {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new ModelError('selection_too_large', 'Clipboard content is too large');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelError('invalid_selection', 'Clipboard does not contain a TPacket selection');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelError('invalid_selection', 'Clipboard does not contain a TPacket selection');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.format === FORMAT && envelope.version === VERSION) value = envelope.project;
  const project = validateProject(value);
  if (!project.devices.length && !project.notes.length && !project.zones.length) {
    throw new ModelError('empty_selection', 'Clipboard selection is empty');
  }
  return project;
}
