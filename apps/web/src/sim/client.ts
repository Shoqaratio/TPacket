import type { SimEvent } from '@netlab/engine';
import { create } from 'zustand';
import type { CliKind, CliResult, OpName, PduView, ProjectView, Request, WorkerMessage } from './protocol';

export class SimError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

interface SimState {
  views: Record<string, ProjectView>;
  events: Record<string, SimEvent[]>;
  pdus: Record<string, PduView[]>;
  /** Incremented on every change that must be persisted. */
  dirty: Record<string, number>;
}

export const useSim = create<SimState>(() => ({ views: {}, events: {}, pdus: {}, dirty: {} }));

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const consoleListeners = new Map<string, Set<(text: string) => void>>();
let seq = 0;
const EVENT_CAP = 2000;

worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const m = ev.data;
  switch (m.type) {
    case 'reply': {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.ok) p.resolve(m.value);
      else p.reject(new SimError(m.error, m.code));
      return;
    }
    case 'view':
      useSim.setState((s) => ({ views: { ...s.views, [m.project]: m.view } }));
      return;
    case 'events':
      useSim.setState((s) => {
        const all = [...(s.events[m.project] ?? []), ...m.events];
        return { events: { ...s.events, [m.project]: all.slice(-EVENT_CAP) } };
      });
      return;
    case 'pdus':
      useSim.setState((s) => ({ pdus: { ...s.pdus, [m.project]: m.pdus } }));
      return;
    case 'dirty':
      useSim.setState((s) => ({ dirty: { ...s.dirty, [m.project]: (s.dirty[m.project] ?? 0) + 1 } }));
      return;
    case 'console':
      consoleListeners.get(`${m.project}|${m.device}`)?.forEach((fn) => fn(m.text));
  }
};

/** Collaboration hook: when set, state-changing requests for a shared project go through the server. */
export const intercept: { route?: (req: Request) => Promise<unknown> | undefined } = {};

/** Sends a request straight to the worker (used by the collaboration layer to apply ordered ops). */
export function direct<T>(req: Request): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, req });
  });
}

function call<T>(req: Request): Promise<T> {
  const routed = intercept.route?.(req);
  if (routed) return routed as Promise<T>;
  return direct<T>(req);
}

export const sim = {
  open: (project: string, doc: unknown) => call<null>({ method: 'open', project, doc: doc as never }),
  close: (project: string) => {
    useSim.setState((s) => {
      const views = { ...s.views };
      delete views[project];
      return { views };
    });
    return call<null>({ method: 'close', project });
  },
  op: <T = unknown>(project: string, op: OpName, ...args: unknown[]) => call<T>({ method: 'op', project, op, args }),
  undo: (project: string) => call<null>({ method: 'undo', project }),
  redo: (project: string) => call<null>({ method: 'redo', project }),
  serialize: (project: string) => call<unknown>({ method: 'serialize', project }),
  runningConfig: (project: string, device: string) => call<string>({ method: 'runningConfig', project, device }),
  diagnose: (project: string, device: string, dst: string, locale: 'fr' | 'en') => call<import('@netlab/engine').Diagnosis>({ method: 'diagnose', project, device, dst, locale }),
  grade: (project: string, rubric: unknown) => call<import('@netlab/engine').GradeReport>({ method: 'grade', project, rubric }),
  browse: (project: string, device: string, url: string) => call<{ status: number; body: string; secure: boolean } | { error: string }>({ method: 'browse', project, device, url }),
  cli: (project: string, session: string, device: string, kind: CliKind, action: 'open' | 'input', text?: string) =>
    call<CliResult>({ method: 'cli', project, session, device, kind, action, ...(text !== undefined ? { text } : {}) }),
  cliHelp: (project: string, session: string, device: string, kind: CliKind, text: string) => call<string>({ method: 'cli', project, session, device, kind, action: 'help', text }),
  cliComplete: (project: string, session: string, device: string, kind: CliKind, text: string) => call<string | null>({ method: 'cli', project, session, device, kind, action: 'complete', text }),
  cliClose: (project: string, session: string, device: string, kind: CliKind) => call<null>({ method: 'cli', project, session, device, kind, action: 'close' }),
  tick: (project: string, ms: number) => call<number>({ method: 'tick', project, ms }),
  simStep: (project: string) => call<boolean>({ method: 'simStep', project }),
  simReset: (project: string) => {
    useSim.setState((s) => ({ events: { ...s.events, [project]: [] } }));
    return call<null>({ method: 'simReset', project });
  },
  simPdu: (project: string, src: string, dst: string, protocol: 'icmp' | 'tcp' | 'udp' = 'icmp', dstPort?: number) =>
    call<number>({ method: 'simPdu', project, src, dst, protocol, ...(dstPort !== undefined ? { dstPort } : {}) }),
  onConsole(project: string, device: string, fn: (text: string) => void): () => void {
    const key = `${project}|${device}`;
    const set = consoleListeners.get(key) ?? new Set();
    set.add(fn);
    consoleListeners.set(key, set);
    return () => set.delete(fn);
  },
};
