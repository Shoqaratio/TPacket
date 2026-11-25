import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Moon, Sun } from 'lucide-react';
import { api, fetchMe, type Me } from './api';
import { leaveCollab } from './collab';
import { AcademyNav } from './components/AcademyNav';
import { Workspace } from './components/Workspace';
import './index.css';
import { Home } from './pages/Home';
import { CoursesPage, ExercisesPage, ProfilePage } from './pages/Academy';
import { StudentPage } from './pages/Student';
import { TeacherPage } from './pages/Teacher';
import { restoreAssignment } from './assignment';
import { startCollab } from './collab';
import { useT } from './i18n';
import { openProject, startAutosave } from './projects';
import { useSim } from './sim/client';
import { useUi } from './store';

function AcademyMasthead({ me }: { me: Me }) {
  const { theme, locale, set, toast } = useUi();
  const t = useT();
  const signOut = async () => {
    try {
      await api('POST', '/auth/logout');
    } catch {
      toast(t('auth.logoutFailed'), 'error');
      return;
    }
    for (const id of useUi.getState().tabs.filter((x) => x.startsWith('collab-'))) leaveCollab(id);
    set({ me: null, tabs: [], active: null, page: 'home' });
  };

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-6 py-3">
      <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="18" fill="none" stroke="#3b82f6" strokeWidth="5" /><circle cx="32" cy="14" r="5" fill="#8b5cf6" /><circle cx="16" cy="42" r="5" fill="#8b5cf6" /><circle cx="48" cy="42" r="5" fill="#8b5cf6" /></svg>
      <h1 className="text-[17px] font-semibold">TPacket <span className="text-accent">Academy</span></h1>
      <div className="flex-1" />
      <button className="rounded px-2 py-1 hover:bg-panel2" onClick={() => set({ locale: locale === 'fr' ? 'en' : 'fr' })}>{locale === 'fr' ? 'EN' : 'FR'}</button>
      <button aria-label={t('view.theme')} className="rounded p-1.5 hover:bg-panel2" onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
      {me.memberships.length > 0 && <button className="rounded border border-line px-3 py-1" onClick={() => set({ page: 'student' })}>{t('student.title')}</button>}
      <span className="text-muted">{me.display_name}</span>
      <button className="rounded border border-line px-2 py-1" onClick={() => void signOut()}>{t('auth.logout')}</button>
    </header>
  );
}

function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="fixed bottom-8 right-4 z-[60] flex flex-col gap-2" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`max-w-sm whitespace-pre-wrap rounded border px-3 py-2 text-[12px] shadow-lg ${x.tone === 'error' ? 'border-bad/60 bg-panel text-bad' : 'border-line bg-panel'}`}>{x.text}</div>
      ))}
    </div>
  );
}

/** Invitation link to a live session: #collab=<cloud project>:<token> (works on load and when pasted into an open tab). */
async function joinFromHash(): Promise<void> {
  const m = /^#collab=([^:]+):(.+)$/.exec(location.hash);
  if (!m || !useUi.getState().me) return;
  history.replaceState(null, '', location.pathname);
  await startCollab(m[1]!, decodeURIComponent(m[2]!)).catch(() => useUi.getState().toast('collaboration refused', 'error'));
}

function App() {
  const { active, theme, locale, set, page, me } = useUi();
  const opened = useSim((s) => (active ? !!s.views[active] : false));
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.lang = locale;
  }, [theme, locale]);

  useEffect(() => {
    if (me) return startAutosave();
  }, [me]);

  useEffect(() => {
    const { tabs, active: last } = useUi.getState();
    useUi.setState({ tabs: [] });
    let cancelled = false;
    void (async () => {
      const signedIn = await fetchMe();
      if (cancelled) return;
      set({ me: signedIn });
      if (signedIn) {
        for (const id of tabs.filter((x) => !x.startsWith('collab-'))) {
          await openProject(id).catch(() => {});
          void restoreAssignment(id);
        }
        if (last && useUi.getState().tabs.includes(last)) await openProject(last);
        else useUi.setState({ active: null });
      } else {
        set({ tabs: [], active: null, page: 'home' });
      }
      if (cancelled) return;
      setRestored(true);
    })();
    const onHash = () => void joinFromHash();
    addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      removeEventListener('hashchange', onHash);
    };
  }, [set]);

  useEffect(() => {
    if (me) void joinFromHash();
  }, [me]);

  if (!restored) return null;
  const workspaceOpen = !!(me && active && opened);
  const academyOpen = !!(me && !workspaceOpen);
  const screenKey = workspaceOpen ? `workspace-${active}` : `${me ? 'page' : 'auth'}-${page}`;
  const screen = me && active && opened
    ? <Workspace key={active} project={active} />
    : !me ? <Home />
    : page === 'teacher' ? <TeacherPage />
    : page === 'student' ? <StudentPage />
    : page === 'courses' ? <CoursesPage />
    : page === 'exercises' ? <ExercisesPage />
    : page === 'profile' ? <ProfilePage />
    : <Home />;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {academyOpen && (
          <>
            <AcademyMasthead me={me} />
            <AcademyNav current={page} me={me} />
          </>
        )}
        <div key={screenKey} className={workspaceOpen ? 'h-full min-h-0' : academyOpen ? 'nl-page-enter min-h-0 flex-1' : 'h-full min-h-0'}>
          {screen}
        </div>
      </div>
      <Toasts />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
