import { useState } from 'react';
import { api } from '../api';
import { sendChat, startCollab, useCollab } from '../collab';
import { useT } from '../i18n';
import { storage } from '../storage';
import { useUi } from '../store';

/** Sharing links, live session, participants, chat and change history. */
export function CollabPanel({ project }: { project: string }) {
  const t = useT();
  const { me, toast } = useUi();
  const s = useCollab((x) => x.sessions[project]);
  const [link, setLink] = useState<string | null>(null);
  const [text, setText] = useState('');
  const orgs = me?.memberships ?? [];
  const [org, setOrg] = useState(orgs[0]?.org_id ?? '');

  if (!s) {
    const share = async (role: 'read' | 'write') => {
      const p = await storage.get(project);
      if (!p?.cloudId) return toast(t('collab.needCloud'), 'error');
      const r = await api<{ token: string }>('POST', `/projects/${p.cloudId}/share`, { org_id: org, role });
      setLink(`${location.origin}${location.pathname}#collab=${p.cloudId}:${r.token}`);
    };
    const start = async () => {
      const p = await storage.get(project);
      if (!p?.cloudId) return toast(t('collab.needCloud'), 'error');
      await startCollab(p.cloudId).catch(() => toast(t('collab.refused'), 'error'));
    };
    return (
      <div className="flex flex-col gap-2 p-3 text-[12px]">
        {!me ? <p className="text-muted">{t('collab.signIn')}</p> : (
          <>
            <p className="text-muted">{t('collab.help')}</p>
            <div className="flex items-center gap-2">
              <select className="rounded border border-line bg-panel2 px-2 py-1" value={org} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o) => <option key={o.org_id} value={o.org_id}>{o.org_name}</option>)}</select>
              <button className="rounded border border-line px-2 py-1" disabled={!org} onClick={() => void share('read')}>{t('collab.demoLink')}</button>
              <button className="rounded border border-line px-2 py-1" disabled={!org} onClick={() => void share('write')}>{t('collab.writeLink')}</button>
              <button className="rounded bg-accent px-3 py-1 text-white" onClick={() => void start()}>{t('collab.start')}</button>
            </div>
            {link && <input readOnly aria-label={t('collab.link')} className="w-full rounded border border-line bg-panel2 px-2 py-1 font-mono" value={link} onFocus={(e) => e.target.select()} />}
          </>
        )}
      </div>
    );
  }
  const name = (id: string) => (id === 'server' ? '⏱' : s.peers.find((p) => p.id === id)?.name ?? id.slice(0, 6));
  return (
    <div className="flex h-full min-h-0 text-[12px]">
      <div className="w-48 shrink-0 border-r border-line p-2">
        <p className="mb-1 font-semibold">{s.status === 'live' ? `● ${t('collab.live')}` : t('collab.closed')}</p>
        <ul>{s.peers.map((p) => <li key={p.id}>{p.name} <span className="text-muted">{p.role === 'write' ? '✎' : '👁'}</span></li>)}</ul>
        {s.me.role === 'read' && <p className="mt-2 text-muted">{t('collab.readOnly')}</p>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <ul className="nl-scroll flex-1 overflow-auto p-2">{s.chat.map((m, i) => <li key={i}><b>{m.name}</b> : {m.text}</li>)}</ul>
        <form className="flex gap-2 border-t border-line p-2" onSubmit={(e) => { e.preventDefault(); sendChat(project, text); setText(''); }}>
          <input aria-label={t('collab.message')} className="flex-1 rounded border border-line bg-panel2 px-2 py-1" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="rounded border border-line px-2">{t('collab.send')}</button>
        </form>
      </div>
      <div className="nl-scroll w-72 shrink-0 overflow-auto border-l border-line p-2">
        <p className="mb-1 font-semibold">{t('collab.history')}</p>
        <ul className="font-mono text-[11px]">{s.history.filter((h) => h.actor !== 'server').slice(-60).reverse().map((h) => <li key={h.seq}>#{h.seq} {name(h.actor)} — {h.summary}</li>)}</ul>
      </div>
    </div>
  );
}
