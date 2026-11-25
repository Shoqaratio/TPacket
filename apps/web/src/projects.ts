import { createProject as newDoc, validateProject } from '@netlab/engine';
import { create } from 'zustand';
import { api, ApiError, type CloudProject } from './api';
import { sim, useSim } from './sim/client';
import { newLocalId, storage, type StoredProject } from './storage';
import { useUi } from './store';
import { decodeSelection, encodeSelection } from './selectionClipboard';

export type SaveState = 'saved' | 'saving' | 'cloud' | 'conflict' | 'offline';

export const useSave = create<{ state: Record<string, SaveState> }>(() => ({ state: {} }));
const setSave = (id: string, s: SaveState) => useSave.setState((x) => ({ state: { ...x.state, [id]: s } }));

const localTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cloudTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function createLocalProject(name: string, doc?: unknown): Promise<string> {
  const id = newLocalId();
  const d = doc ? validateProject(doc) : newDoc(name);
  d.name = name;
  await storage.put({ id, name, doc: d, updatedAt: Date.now() });
  await openProject(id);
  return id;
}

export async function openProject(id: string): Promise<void> {
  const ui = useUi.getState();
  if (!useSim.getState().views[id]) {
    const p = await storage.get(id);
    if (!p) throw new Error('project not found');
    await sim.open(id, p.doc);
  }
  ui.set({ tabs: ui.tabs.includes(id) ? ui.tabs : [...ui.tabs, id], active: id, selection: [], cliDevice: null, windowDevice: null });
  setSave(id, 'saved');
}

export async function closeProject(id: string): Promise<void> {
  if (id.startsWith('collab-')) (await import('./collab')).leaveCollab(id);
  else await flush(id);
  await sim.close(id);
  const ui = useUi.getState();
  const tabs = ui.tabs.filter((t) => t !== id);
  ui.set({ tabs, active: ui.active === id ? (tabs[tabs.length - 1] ?? null) : ui.active });
}

async function saveLocal(id: string): Promise<StoredProject | undefined> {
  const doc = (await sim.serialize(id)) as { name: string };
  const prev = await storage.get(id);
  const next: StoredProject = { ...(prev ?? { id }), id, name: doc.name, doc, updatedAt: Date.now() };
  await storage.put(next);
  return next;
}

async function saveCloud(id: string): Promise<void> {
  const me = useUi.getState().me;
  if (!me) return;
  const p = await storage.get(id);
  if (!p) return;
  try {
    if (p.cloudId) {
      const r = await api<CloudProject>('PUT', `/projects/${p.cloudId}`, { name: p.name, data: p.doc, base_version: p.cloudVersion });
      await storage.put({ ...p, cloudVersion: r.version });
    } else {
      const r = await api<CloudProject>('POST', '/projects', { name: p.name, data: p.doc });
      await storage.put({ ...p, cloudId: r.id, cloudVersion: r.version });
    }
    setSave(id, 'cloud');
  } catch (e) {
    setSave(id, e instanceof ApiError && e.status === 409 ? 'conflict' : 'offline');
  }
}

/** Debounced autosave, wired to the worker's "dirty" notifications. */
export function startAutosave(): () => void {
  let last: Record<string, number> = {};
  return useSim.subscribe((s) => {
    for (const [id, n] of Object.entries(s.dirty)) {
      if (last[id] === n || id.startsWith('collab-')) continue;
      setSave(id, 'saving');
      clearTimeout(localTimers.get(id));
      localTimers.set(id, setTimeout(() => {
        void saveLocal(id).then(() => {
          if (useSave.getState().state[id] !== 'conflict') setSave(id, 'saved');
          clearTimeout(cloudTimers.get(id));
          cloudTimers.set(id, setTimeout(() => void saveCloud(id), 2500));
        });
      }, 600));
    }
    last = { ...s.dirty };
  });
}

export async function flush(id: string): Promise<void> {
  if (localTimers.has(id)) {
    clearTimeout(localTimers.get(id));
    localTimers.delete(id);
    if (useSim.getState().views[id]) await saveLocal(id);
  }
}

/** After sign-in: bring cloud projects that are not on this browser yet. */
export async function pullCloud(): Promise<void> {
  const list = await api<CloudProject[]>('GET', '/projects');
  const local = await storage.list();
  for (const c of list) {
    if (local.some((l) => l.cloudId === c.id)) continue;
    const full = await api<CloudProject>('GET', `/projects/${c.id}`);
    await storage.put({ id: newLocalId(), name: c.name, doc: full.data, updatedAt: Date.parse(c.updated_at), cloudId: c.id, cloudVersion: c.version });
  }
}

/** Resolves a cloud conflict by keeping this browser's version as a new cloud copy. */
export async function saveAsCloudCopy(id: string): Promise<void> {
  const p = await storage.get(id);
  if (!p) return;
  const copy = { ...p };
  delete copy.cloudId;
  delete copy.cloudVersion;
  await storage.put(copy);
  setSave(id, 'saving');
  await saveCloud(id);
}

export function downloadFile(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportNetlab(id: string): Promise<void> {
  const doc = (await sim.serialize(id)) as { name: string };
  downloadFile(`${doc.name.replace(/[^\w.-]+/g, '_') || 'projet'}.netlab`, JSON.stringify(doc, null, 2), 'application/json');
}

export async function importNetlabFile(file: File): Promise<string> {
  if (file.size > 4 * 1024 * 1024) throw new Error('too large');
  const doc = validateProject(JSON.parse(await file.text()));
  return createLocalProject(doc.name || file.name.replace(/\.netlab$/, ''), doc);
}

export async function copySelectionToClipboard(project: string, selected: string[]): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access requires a secure browser context');
  const doc = validateProject(await sim.serialize(project));
  await navigator.clipboard.writeText(encodeSelection(doc, selected));
}

export async function pasteSelectionFromClipboard(project: string): Promise<string[]> {
  if (!navigator.clipboard?.readText) throw new Error('Clipboard access requires a secure browser context');
  const doc = decodeSelection(await navigator.clipboard.readText());
  return sim.op<string[]>(project, 'pasteSelection', doc, 40, 40);
}
