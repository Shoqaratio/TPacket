import { FolderOpen, Moon, Plus, Sun, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me } from '../api';
import { leaveCollab } from '../collab';
import { AcademyNav } from '../components/AcademyNav';
import { useT } from '../i18n';
import { createLocalProject, importNetlabFile, openProject, pullCloud } from '../projects';
import { storage, type StoredProject } from '../storage';
import { useUi } from '../store';

function AuthForm({ onDone }: { onDone(me: Me): void }) {
  const t = useT();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const locale = useUi((s) => s.locale);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const me = mode === 'login' ? await api<Me>('POST', '/auth/login', { email, password }) : await api<Me>('POST', '/auth/register', { email, password, display_name: name, locale });
      onDone(me);
    } catch (x) {
      const code = x instanceof ApiError ? x.code : 'offline';
      setErr(code === 'offline' || (x instanceof ApiError && x.status >= 500) ? t('auth.offline') : t(`err.${code}`) === `err.${code}` ? t('err.generic') : t(`err.${code}`));
    }
  };
  const input = 'rounded border border-line bg-panel2 px-2 py-1.5 outline-none focus:border-accent';
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 text-[13px]" aria-label={t(mode === 'login' ? 'auth.login' : 'auth.register')}>
      <h2 className="text-[15px] font-semibold">{t(mode === 'login' ? 'auth.login' : 'auth.register')}</h2>
      {mode === 'register' && <label className="flex flex-col gap-0.5"><span className="text-muted">{t('auth.name')}</span><input className={input} required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
      <label className="flex flex-col gap-0.5"><span className="text-muted">{t('auth.email')}</span><input className={input} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
      <label className="flex flex-col gap-0.5"><span className="text-muted">{t('auth.password')}</span><input className={input} type="password" required minLength={mode === 'register' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {err && <p className="text-bad" role="alert">{err}</p>}
      <button className="rounded bg-accent py-1.5 text-white hover:brightness-110">{t('auth.submit')}</button>
      <button type="button" className="text-[12px] text-accent" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{t(mode === 'login' ? 'auth.noAccount' : 'auth.haveAccount')}</button>
    </form>
  );
}

function JoinForm({ onDone }: { onDone(me: Me): void }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="flex gap-2" onSubmit={(e) => {
      e.preventDefault();
      api<Me>('POST', '/auth/invites/redeem', { code }).then(onDone, () => setErr(t('err.invalid_code')));
    }}>
      <input aria-label={t('auth.code')} placeholder={t('auth.code')} className="min-w-0 flex-1 rounded border border-line bg-panel2 px-2 py-1 font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} />
      <button className="rounded border border-line px-3">{t('auth.join')}</button>
      {err && <span className="text-bad">{err}</span>}
    </form>
  );
}

export function Home() {
  const t = useT();
  const ui = useUi();
  const [projects, setProjects] = useState<StoredProject[]>([]);
  const [assignments, setAssignments] = useState<{ attempts: number }[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const reload = () => void storage.list().then(setProjects);
  useEffect(() => {
    if (ui.me) reload();
    else setProjects([]);
  }, [ui.me]);
  useEffect(() => {
    if (ui.me) void pullCloud().then(reload).catch(() => {});
  }, [ui.me]);
  useEffect(() => {
    let cancelled = false;
    if (!ui.me) {
      setAssignments(null);
      return () => { cancelled = true; };
    }
    void api<{ assignments: { attempts: number }[] }>('GET', '/me/assignments').then((r) => {
      if (!cancelled) setAssignments(r.assignments);
    }).catch(() => {
      if (!cancelled) {
        setAssignments(null);
        ui.toast(t('academy.loadError'), 'error');
      }
    });
    return () => { cancelled = true; };
  }, [ui.me]);

  const signedIn = (me: Me) => ui.set({ me });
  const signOut = async () => {
    try {
      await api('POST', '/auth/logout');
    } catch {
      ui.toast(t('auth.logoutFailed'), 'error');
      return;
    }
    for (const id of useUi.getState().tabs.filter((x) => x.startsWith('collab-'))) leaveCollab(id);
    ui.set({ me: null, tabs: [], active: null, page: 'home' });
  };
  if (!ui.me) {
    return (
      <main className="nl-scroll grid h-full overflow-auto bg-bg p-6">
        <section className="m-auto w-full max-w-md rounded-lg border border-line bg-panel p-6 shadow-lg">
          <header className="mb-5 flex items-center gap-3">
            <h1 className="text-[17px] font-semibold">TPacket <span className="text-accent">Academy</span></h1>
            <div className="flex-1" />
            <button className="rounded px-2 py-1 hover:bg-panel2" onClick={() => ui.set({ locale: ui.locale === 'fr' ? 'en' : 'fr' })}>{ui.locale === 'fr' ? 'EN' : 'FR'}</button>
            <button aria-label={t('view.theme')} className="rounded p-1.5 hover:bg-panel2" onClick={() => ui.set({ theme: ui.theme === 'dark' ? 'light' : 'dark' })}>{ui.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          </header>
          <h2 className="mb-2 text-[15px] font-semibold">{t('auth.requiredTitle')}</h2>
          <p className="mb-5 text-[13px] text-muted">{t('auth.requiredDescription')}</p>
          <AuthForm onDone={signedIn} />
        </section>
      </main>
    );
  }

  return (
    <div className="nl-scroll h-full overflow-auto">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="18" fill="none" stroke="#3b82f6" strokeWidth="5" /><circle cx="32" cy="14" r="5" fill="#8b5cf6" /><circle cx="16" cy="42" r="5" fill="#8b5cf6" /><circle cx="48" cy="42" r="5" fill="#8b5cf6" /></svg>
        <h1 className="text-[17px] font-semibold">TPacket <span className="text-accent">Academy</span></h1>
        <div className="flex-1" />
        <button className="rounded px-2 py-1 hover:bg-panel2" onClick={() => ui.set({ locale: ui.locale === 'fr' ? 'en' : 'fr' })}>{ui.locale === 'fr' ? 'EN' : 'FR'}</button>
        <button aria-label={t('view.theme')} className="rounded p-1.5 hover:bg-panel2" onClick={() => ui.set({ theme: ui.theme === 'dark' ? 'light' : 'dark' })}>{ui.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
        {ui.me && (
          <>
            {ui.me.memberships.length > 0 && <button className="rounded border border-line px-3 py-1" onClick={() => ui.set({ page: 'student' })}>{t('student.title')}</button>}
            <span className="text-muted">{ui.me.display_name}</span>
            <button className="rounded border border-line px-2 py-1" onClick={() => void signOut()}>{t('auth.logout')}</button>
          </>
        )}
      </header>
      <AcademyNav current="home" me={ui.me} />
      <main className="mx-auto max-w-6xl px-6 pt-5">
        <h2 className="mb-3 text-[16px] font-semibold">{t('academy.dashboard')}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-line bg-panel p-3"><div className="text-[11px] uppercase text-muted">{t('home.projects')}</div><div className="text-[22px] font-semibold">{projects.length}</div></div>
          <div className="rounded-lg border border-line bg-panel p-3"><div className="text-[11px] uppercase text-muted">{t('academy.activities')}</div><div className="text-[22px] font-semibold">{assignments?.length ?? '—'}</div></div>
          <div className="rounded-lg border border-line bg-panel p-3"><div className="text-[11px] uppercase text-muted">{t('academy.toDo')}</div><div className="text-[22px] font-semibold">{assignments ? assignments.filter((a) => !a.attempts).length : '—'}</div></div>
          <div className="rounded-lg border border-line bg-panel p-3"><div className="text-[11px] uppercase text-muted">{t('academy.memberships')}</div><div className="text-[22px] font-semibold">{ui.me.memberships.length}</div></div>
        </div>
      </main>
      <div className="mx-auto grid max-w-6xl gap-6 p-6 md:grid-cols-[1fr_300px]">
        <section>
          <div className="mb-1 flex items-center gap-2">
            <h2 className="text-[16px] font-semibold">{t('home.lab')}</h2>
            <div className="flex-1" />
            <button className="flex items-center gap-1 rounded border border-line px-3 py-1.5 hover:bg-panel2" onClick={() => file.current?.click()}><Upload size={14} /> {t('home.import')}</button>
            <button className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-white hover:brightness-110" onClick={() => void createLocalProject(`${t('file.new')} ${projects.length + 1}`)}><Plus size={14} /> {t('home.new')}</button>
          </div>
          <p className="mb-4 text-[12px] text-muted">{t('home.labDesc')}</p>
          {projects.length === 0 ? (
            <p className="rounded border border-dashed border-line p-8 text-center text-muted">{t('home.empty')}</p>
          ) : (
            <table className="w-full overflow-hidden rounded border border-line bg-panel text-[13px]">
              <thead className="bg-panel2 text-left text-[12px] text-muted"><tr><th className="px-3 py-2">{t('home.projects')}</th><th>{t('home.updated')}</th><th></th><th></th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="border-t border-line hover:bg-panel2">
                    <td className="px-3 py-2"><button className="font-medium hover:text-accent" onClick={() => void openProject(p.id)}>{p.name}</button></td>
                    <td className="text-[12px] text-muted">{new Date(p.updatedAt).toLocaleString(ui.locale)}</td>
                    <td><span className={`rounded px-1.5 py-0.5 text-[10px] ${p.cloudId ? 'bg-accent2/20 text-accent2' : 'bg-panel2 text-muted'}`}>{p.cloudId ? t('home.cloud') : t('home.local')}</span></td>
                    <td className="whitespace-nowrap pr-2 text-right">
                      <button aria-label={t('home.open')} className="rounded p-1.5 hover:bg-panel" onClick={() => void openProject(p.id)}><FolderOpen size={15} /></button>
                      <button aria-label={t('home.delete')} className="rounded p-1.5 text-bad hover:bg-panel" onClick={() => { if (confirm(t('home.confirmDelete'))) void storage.remove(p.id).then(reload); }}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside className="flex flex-col gap-4">
          <div className="rounded-lg border border-line bg-panel p-4">
            {ui.me ? (
              <div className="flex flex-col gap-2 text-[13px]">
                <p>{ui.me.email}</p>
                {ui.me.memberships.map((m) => <p key={m.org_id} className="text-muted">{m.org_name} — {m.role}</p>)}
                <JoinForm onDone={signedIn} />
              </div>
            ) : (
              <AuthForm onDone={signedIn} />
            )}
          </div>
        </aside>
      </div>
      <input ref={file} type="file" accept=".netlab,application/json" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void importNetlabFile(f).catch(() => ui.toast(t('err.invalidFile'), 'error'));
        e.target.value = '';
      }} />
    </div>
  );
}
