import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { checkAssignment, reportEvent, submitAssignment, useAssignment } from '../assignment';
import { useT } from '../i18n';
import { useUi } from '../store';

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Statement, timer, intermediate checks and submission for a student's working copy. */
export function AssignmentBar({ project }: { project: string }) {
  const t = useT();
  const toast = useUi((s) => s.toast);
  const a = useAssignment((s) => s.byProject[project]);
  const [now, setNow] = useState(Date.now());
  const [statement, setStatement] = useState(false);
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof checkAssignment>>['results'] | null>(null);
  const [busy, setBusy] = useState(false);
  const autoSubmitted = useRef(false);

  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  // Exam session events (stored only if the school enabled it — informative, never proof of cheating).
  useEffect(() => {
    if (!a?.exam) return;
    const vis = () => reportEvent(project, document.hidden ? 'tab_hidden' : 'tab_visible');
    const off = () => reportEvent(project, 'offline');
    const on = () => reportEvent(project, 'online');
    document.addEventListener('visibilitychange', vis);
    addEventListener('offline', off);
    addEventListener('online', on);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      removeEventListener('offline', off);
      removeEventListener('online', on);
    };
  }, [a?.exam, project]);

  const remaining = a?.deadline ? Date.parse(a.deadline) - (now - a.skew) : null;

  const submit = async (auto = false) => {
    setBusy(true);
    try {
      const r = await submitAssignment(project);
      toast(auto ? t('asg.autoSubmitted', { n: r.attempt }) : t('asg.submitted', { n: r.attempt }));
    } catch (e) {
      toast(t(`asg.err.${e instanceof ApiError ? e.code : 'generic'}`), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (a?.exam && remaining !== null && remaining <= 0 && !autoSubmitted.current) {
      autoSubmitted.current = true;
      void submit(true);
    }
  });

  if (!a) return null;
  const attemptsLeft = a.max_attempts ? a.max_attempts - a.attempts : null;
  return (
    <div className="flex items-center gap-3 border-b border-line bg-accent2/10 px-3 py-1 text-[12px]" role="region" aria-label={t('asg.title')}>
      <span className="rounded bg-accent2 px-1.5 text-[10px] font-bold uppercase text-white">{a.exam ? t('asg.exam') : t('asg.assignment')}</span>
      <b>{a.title}</b>
      <button className="text-accent underline" onClick={() => setStatement(true)}>{t('asg.statement')}</button>
      {remaining !== null && <span className={`font-mono ${remaining < 5 * 60_000 ? 'text-bad' : ''}`} aria-live="off">⏱ {fmt(remaining)}</span>}
      {attemptsLeft !== null && <span className="text-muted">{t('asg.attemptsLeft', { n: attemptsLeft })}</span>}
      <div className="flex-1" />
      {a.allow_checks && (
        <button disabled={busy} className="rounded border border-line px-2 py-0.5" onClick={() => void checkAssignment(project).then((r) => setChecks(r.results), (e) => toast(t(`asg.err.${e instanceof ApiError ? e.code : 'generic'}`), 'error'))}>{t('asg.check')}</button>
      )}
      <button disabled={busy || attemptsLeft === 0} className="rounded bg-accent2 px-3 py-0.5 text-white disabled:opacity-40" onClick={() => { if (confirm(t('asg.confirmSubmit'))) void submit(); }}>{t('asg.submit')}</button>
      <Dialog.Root open={statement || !!checks} onOpenChange={(o) => { if (!o) { setStatement(false); setChecks(null); } }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="nl-scroll fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[640px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-line bg-panel p-5 text-[13px] shadow-2xl">
            <Dialog.Title className="mb-3 text-[15px] font-semibold">{checks ? t('asg.checkResults') : a.title}</Dialog.Title>
            {checks ? (
              <ul className="flex flex-col gap-1">
                {checks.map((c) => (
                  <li key={c.id} className={c.passed ? 'text-ok' : 'text-bad'}>{c.passed ? '✓' : '✗'} {c.id} — {c.message}{c.feedback ? ` (${c.feedback})` : ''}</li>
                ))}
              </ul>
            ) : (
              <>
                <div className="whitespace-pre-wrap">{a.statement}</div>
                <h3 className="mb-1 mt-4 font-semibold">{t('asg.criteria')}</h3>
                <ul className="list-disc pl-5 text-muted">{a.criteria.map((c) => <li key={c.id}>{c.id} ({t(`crit.${c.type}`)}) — {c.points} pt</li>)}</ul>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
