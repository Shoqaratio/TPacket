import { create } from 'zustand';
import { api } from './api';
import { createLocalProject, openProject } from './projects';
import { sim } from './sim/client';
import { storage } from './storage';

export interface AssignmentCtx {
  id: string;
  title: string;
  statement: string;
  exam: boolean;
  deadline: string | null;
  allow_checks: boolean;
  allow_tutor: boolean;
  max_attempts: number;
  attempts: number;
  criteria: { id: string; type: string; points: number }[];
  max_score: number | null;
  /** client clock minus server clock, ms. */
  skew: number;
}

export const useAssignment = create<{ byProject: Record<string, AssignmentCtx> }>(() => ({ byProject: {} }));

async function load(aid: string): Promise<AssignmentCtx & { initial_project: unknown }> {
  const a = await api<AssignmentCtx & { initial_project: unknown; server_time: string; started_at: string | null }>('GET', `/assignments/${aid}`);
  return { ...a, skew: Date.now() - Date.parse(a.server_time) };
}

/** Opens (or resumes) the student's working copy of an assignment. */
export async function openAssignment(aid: string): Promise<string> {
  await api('POST', `/assignments/${aid}/start`);
  const a = await load(aid);
  const existing = (await storage.list()).find((p) => p.assignmentId === aid);
  let pid: string;
  if (existing) {
    pid = existing.id;
    await openProject(pid);
  } else {
    pid = await createLocalProject(a.title, a.initial_project);
    const p = await storage.get(pid);
    if (p) await storage.put({ ...p, assignmentId: aid });
  }
  useAssignment.setState((s) => ({ byProject: { ...s.byProject, [pid]: a } }));
  return pid;
}

/** Restores the assignment context of a project re-opened after a reload. */
export async function restoreAssignment(pid: string): Promise<void> {
  const p = await storage.get(pid);
  if (!p?.assignmentId) return;
  try {
    const a = await load(p.assignmentId);
    useAssignment.setState((s) => ({ byProject: { ...s.byProject, [pid]: a } }));
  } catch {
    /* offline: the bar stays hidden, work continues locally */
  }
}

export async function checkAssignment(pid: string) {
  const a = useAssignment.getState().byProject[pid]!;
  const project = await sim.serialize(pid);
  return api<{ results: { id: string; type: string; passed: boolean; message: string; feedback?: string }[] }>('POST', `/assignments/${a.id}/check`, { project });
}

export async function submitAssignment(pid: string, justification = '') {
  const a = useAssignment.getState().byProject[pid]!;
  const project = await sim.serialize(pid);
  const r = await api<{ id: string; attempt: number }>('POST', `/assignments/${a.id}/submissions`, { project, justification });
  useAssignment.setState((s) => ({ byProject: { ...s.byProject, [pid]: { ...a, attempts: r.attempt } } }));
  return r;
}

export function reportEvent(pid: string, kind: 'tab_hidden' | 'tab_visible' | 'offline' | 'online'): void {
  const a = useAssignment.getState().byProject[pid];
  if (a?.exam) void api('POST', `/assignments/${a.id}/events`, { kind }).catch(() => {});
}
