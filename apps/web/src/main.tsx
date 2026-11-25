import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchMe } from './api';
import { Workspace } from './components/Workspace';
import './index.css';
import { Home } from './pages/Home';
import { StudentPage } from './pages/Student';
import { TeacherPage } from './pages/Teacher';
import { restoreAssignment } from './assignment';
import { startCollab } from './collab';
import { openProject, startAutosave } from './projects';
import { useSim } from './sim/client';
import { useUi } from './store';

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
  const { active, theme, locale, set, page } = useUi();
  const opened = useSim((s) => (active ? !!s.views[active] : false));
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.lang = locale;
  }, [theme, locale]);

  useEffect(() => {
    const stop = startAutosave();
    // Re-open the tabs of the previous session, then (if any) join a shared live session.
    const { tabs, active: last } = useUi.getState();
    useUi.setState({ tabs: [] });
    void (async () => {
      for (const id of tabs.filter((x) => !x.startsWith('collab-'))) {
        await openProject(id).catch(() => {});
        void restoreAssignment(id);
      }
      if (last && useUi.getState().tabs.includes(last)) await openProject(last);
      else useUi.setState({ active: null });
      setRestored(true);
      set({ me: await fetchMe() });
      await joinFromHash();
    })();
    const onHash = () => void joinFromHash();
    addEventListener('hashchange', onHash);
    return () => {
      stop();
      removeEventListener('hashchange', onHash);
    };
  }, [set]);

  if (!restored) return null;
  return (
    <>
      {active && opened ? <Workspace key={active} project={active} /> : page === 'teacher' ? <TeacherPage /> : page === 'student' ? <StudentPage /> : <Home />}
      <Toasts />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
