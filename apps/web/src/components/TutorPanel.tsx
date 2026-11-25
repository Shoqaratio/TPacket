import type { Diagnosis } from '@netlab/engine';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { sim, useSim } from '../sim/client';
import { useUi } from '../store';
import { useAssignment } from '../assignment';

const LEVELS = ['tutor.l1', 'tutor.l2', 'tutor.l3', 'tutor.l4', 'tutor.l5'];

/** Rule-based assistant: explains why a ping fails, with progressive hints. */
export function TutorPanel({ project }: { project: string }) {
  const t = useT();
  const locale = useUi((s) => s.locale);
  const view = useSim((s) => s.views[project]);
  const ctx = useAssignment((s) => s.byProject[project]);
  const hosts = (view?.devices ?? []).filter((d) => d.ips.length > 0);
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [shown, setShown] = useState(1);
  const [ai, setAi] = useState(false);
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const me = useUi((s) => s.me);
  useEffect(() => {
    if (me) void api<{ enabled: boolean }>('GET', '/tutor/ai/status').then((r) => setAi(r.enabled), () => setAi(false));
  }, [me]);
  // Graded work: full correction (level 5) only when the teacher allows the tutor; exams with the tutor disabled hide it.
  const maxLevel = !ctx ? 5 : ctx.allow_tutor ? 4 : 0;
  if (maxLevel === 0) return <p className="p-3 text-[12px] text-muted">{t('tutor.disabled')}</p>;
  const select = 'rounded border border-line bg-panel2 px-2 py-1';
  return (
    <div className="nl-scroll flex h-full gap-4 overflow-auto p-3 text-[12px]">
      <form className="flex w-64 shrink-0 flex-col gap-2" onSubmit={(e) => {
        e.preventDefault();
        if (!src || !dst) return;
        void sim.diagnose(project, src, dst, locale).then((d) => { setDiag(d); setShown(1); });
      }}>
        <p className="font-semibold">{t('tutor.question')}</p>
        <label className="flex flex-col gap-0.5"><span className="text-muted">{t('tutor.source')}</span>
          <select className={select} value={src} onChange={(e) => setSrc(e.target.value)}><option value="" />{hosts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="flex flex-col gap-0.5"><span className="text-muted">{t('tutor.destination')}</span>
          <input list="tutor-dst" className={select} value={dst} onChange={(e) => setDst(e.target.value)} placeholder="192.168.2.10 / PC1" />
          <datalist id="tutor-dst">{hosts.map((d) => <option key={d.id} value={d.name} />)}</datalist></label>
        <button className="self-start rounded bg-accent2 px-3 py-1 text-white">{t('tutor.ask')}</button>
        <p className="text-[11px] text-muted">{t('tutor.noai')}</p>
      </form>
      {diag && (
        <div className="flex-1" aria-live="polite">
          <p className={`mb-2 font-semibold ${diag.ok ? 'text-ok' : 'text-warn'}`}>{diag.ok ? '✓' : '!'} {diag.path.length ? `${diag.path.join(' → ')}` : ''}</p>
          <ol className="flex flex-col gap-2">
            {diag.hints.slice(0, Math.min(shown, maxLevel)).map((h, i) => (
              <li key={i} className="rounded border border-line bg-panel2 p-2"><span className="mr-2 text-[11px] font-semibold uppercase text-accent2">{t(LEVELS[i]!)}</span>{h}</li>
            ))}
          </ol>
          {shown < Math.min(5, maxLevel) && !diag.ok && <button className="mt-2 rounded border border-line px-3 py-1" onClick={() => setShown(shown + 1)}>{t('tutor.next')}</button>}
          {ctx && shown >= maxLevel && maxLevel < 5 && <p className="mt-2 text-muted">{t('tutor.limit')}</p>}
        </div>
      )}
      {ai && (
        <form className="flex w-72 shrink-0 flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          void api<{ answer: string }>('POST', '/tutor/ai', { question: q, diagnosis: diag ? diag.hints.slice(0, 3).join('\n') : '', locale, ...(ctx ? { assignment_id: ctx.id } : {}) }).then((r) => setAnswer(r.answer), () => setAnswer(t('tutor.aiError')));
        }}>
          <p className="font-semibold">{t('tutor.aiTitle')}</p>
          <textarea aria-label={t('tutor.aiTitle')} className="h-20 rounded border border-line bg-panel2 p-2" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="self-start rounded border border-line px-3 py-1">{t('tutor.ask')}</button>
          {answer && <p className="whitespace-pre-wrap rounded border border-line bg-panel2 p-2">{answer}</p>}
          <p className="text-[11px] text-muted">{t('tutor.aiNote')}</p>
        </form>
      )}
    </div>
  );
}
