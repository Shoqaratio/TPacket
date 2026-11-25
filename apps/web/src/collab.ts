/**
 * Real-time collaboration client.
 * State-changing requests on a shared project are not executed locally: they are sent to the
 * server, which orders them, and every participant (including the author) applies the ordered log
 * to its own deterministic engine. Clock ticks come from the server too, so all copies stay equal.
 */
import { create } from 'zustand';
import { direct, intercept, SimError } from './sim/client';
import type { Request } from './sim/protocol';
import { useUi } from './store';

interface Peer { id: string; name: string; role: string }
interface ChatMsg { actor: string; name: string; text: string; at: string }
interface HistoryItem { seq: number; actor: string; summary: string }

interface Session {
  cloudId: string;
  ws: WebSocket;
  me: Peer;
  peers: Peer[];
  cursors: Record<string, { x: number; y: number; name: string; at: number }>;
  chat: ChatMsg[];
  history: HistoryItem[];
  status: 'connecting' | 'live' | 'closed';
}

export const useCollab = create<{ sessions: Record<string, Session> }>(() => ({ sessions: {} }));

const READ_ONLY = new Set(['serialize', 'runningConfig', 'diagnose', 'grade']);
const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
let cidSeq = 0;
const chains = new Map<string, Promise<unknown>>();

function patch(project: string, p: Partial<Session>): void {
  useCollab.setState((s) => ({ sessions: { ...s.sessions, [project]: { ...s.sessions[project]!, ...p } } }));
}

function summary(req: Request): string {
  if (req.method === 'op') return `${req.op}`;
  if (req.method === 'cli') return `CLI ${req.text ?? ''}`.trim();
  return req.method;
}

intercept.route = (req) => {
  const s = useCollab.getState().sessions[req.project];
  if (!s || s.status === 'closed') return undefined;
  if (READ_ONLY.has(req.method) || (req.method === 'cli' && req.action !== 'input')) {
    if (req.method === 'cli') return direct({ ...req, session: `${s.me.id}|${req.session}` });
    return undefined;
  }
  if (req.method === 'tick') return Promise.resolve(null); // the server drives the shared clock
  if (req.method === 'close' || req.method === 'open') return undefined;
  if (s.me.role !== 'write') return Promise.reject(new SimError('read only', 'read_only'));
  const cid = `${s.me.id}:${++cidSeq}`;
  const { project: _p, ...body } = req;
  void _p;
  s.ws.send(JSON.stringify({ type: 'op', op: { kind: 'req', req: body, cid } }));
  return new Promise((resolve, reject) => pending.set(cid, { resolve, reject }));
};

function apply(project: string, entry: { seq: number; actor: string; op: { kind: string; req?: Record<string, unknown>; cid?: string; ms?: number } }): void {
  const prev = chains.get(project) ?? Promise.resolve();
  const next = prev.then(async () => {
    const op = entry.op;
    if (op.kind === 'tick') return direct({ method: 'tick', project, ms: Math.min(Number(op.ms) || 1000, 5000) });
    if (op.kind !== 'req' || !op.req) return;
    const req = { ...op.req, project } as Request;
    if (req.method === 'cli') (req as { session: string }).session = `${entry.actor}|${(req as { session: string }).session}`;
    const s = useCollab.getState().sessions[project];
    patch(project, { history: [...(s?.history ?? []), { seq: entry.seq, actor: entry.actor, summary: summary(req) }].slice(-200) });
    const p = op.cid ? pending.get(op.cid) : undefined;
    try {
      const v = await direct(req);
      if (p) p.resolve(v);
    } catch (e) {
      if (p) p.reject(e as Error);
    } finally {
      if (op.cid) pending.delete(op.cid);
    }
  });
  chains.set(project, next.catch(() => {}));
}

/** Joins (or starts) the live session of a cloud project. Returns the local tab id. */
export function startCollab(cloudId: string, token?: string): Promise<string> {
  const project = `collab-${cloudId}`;
  const existing = useCollab.getState().sessions[project];
  if (existing && existing.status !== 'closed') return Promise.resolve(project);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws/projects/${cloudId}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  return new Promise((resolve, reject) => {
    let saveTimer: ReturnType<typeof setInterval> | undefined;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.type === 'init') {
        useCollab.setState((st) => ({ sessions: { ...st.sessions, [project]: { cloudId, ws, me: m.you, peers: m.peers, cursors: {}, chat: m.chat ?? [], history: [], status: 'live' } } }));
        void direct({ method: 'open', project, doc: m.base }).then(() => {
          for (const e of m.ops) apply(project, e);
          const ui = useUi.getState();
          ui.set({ tabs: ui.tabs.includes(project) ? ui.tabs : [...ui.tabs, project], active: project, selection: [] });
          resolve(project);
        }, reject);
        if (m.you.role === 'write') {
          saveTimer = setInterval(() => {
            void direct<unknown>({ method: 'serialize', project }).then((doc) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'save', doc })));
          }, 20_000);
        }
      } else if (m.type === 'op') apply(project, m);
      else if (m.type === 'presence') patch(project, { peers: m.peers });
      else if (m.type === 'cursor') {
        const s = useCollab.getState().sessions[project];
        if (s) patch(project, { cursors: { ...s.cursors, [m.actor]: { x: m.x, y: m.y, name: m.name, at: Date.now() } } });
      } else if (m.type === 'chat') {
        const s = useCollab.getState().sessions[project];
        if (s) patch(project, { chat: [...s.chat, m].slice(-200) });
      } else if (m.type === 'error') useUi.getState().toast(`collaboration: ${m.code}`, 'error');
    };
    ws.onclose = () => {
      clearInterval(saveTimer);
      if (useCollab.getState().sessions[project]) patch(project, { status: 'closed' });
      else reject(new Error('refused'));
    };
  });
}

export function sendCursor(project: string, x: number, y: number): void {
  const s = useCollab.getState().sessions[project];
  if (s?.status === 'live') s.ws.send(JSON.stringify({ type: 'cursor', x, y }));
}

export function sendChat(project: string, text: string): void {
  const s = useCollab.getState().sessions[project];
  if (s?.status === 'live' && text.trim()) s.ws.send(JSON.stringify({ type: 'chat', text }));
}

export function leaveCollab(project: string): void {
  useCollab.getState().sessions[project]?.ws.close();
}
