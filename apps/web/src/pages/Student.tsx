import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { openAssignment } from '../assignment';
import { LearningProgress } from '../components/LearningProgress';
import { useT } from '../i18n';
import { useUi } from '../store';

interface Item {
  id: string;
  title: string;
  class_name: string;
  due_at: string | null;
  deadline: string | null;
  exam: boolean;
  duration_min: number | null;
  attempts: number;
  max_attempts: number;
  kind: 'exercise' | 'incident';
  score?: number | null;
  max_score: number | null;
  submissions: string[];
}
interface Sub { id: string; attempt: number; status: string; score?: number; max_score?: number; feedback?: string; report?: { results: { id: string; passed: boolean; message: string; feedback?: string }[]; hidden_summary?: { count: number; passed: number } } }

const card = 'rounded-lg border border-line bg-panel p-4';

export function StudentPage() {
  const t = useT();
  const { me, set, toast } = useUi();
  const [data, setData] = useState<{ assignments: Item[]; average_20: number | null; announcements: { text: string; created_at: string }[] } | null>(null);
  const [subs, setSubs] = useState<{ item: Item; subs: Sub[] } | null>(null);
  useEffect(() => void api<NonNullable<typeof data>>('GET', '/me/assignments').then(setData), []);
  const open = async (a: Item) => {
    if (a.exam && !a.attempts && !confirm(t('student.examConfirm', { n: a.duration_min ?? '—' }))) return;
    try {
      await openAssignment(a.id);
    } catch (e) {
      toast(t(`asg.err.${e instanceof ApiError ? e.code : 'generic'}`), 'error');
    }
  };
  return (
    <div className="nl-scroll h-full overflow-auto">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <button onClick={() => set({ page: 'home' })} aria-label="back"><ArrowLeft size={16} /></button>
        <h1 className="text-[16px] font-semibold">{t('student.title')}</h1>
        <div className="flex-1" />
        {data?.average_20 !== null && data?.average_20 !== undefined && <span className="rounded bg-accent2/15 px-3 py-1 font-semibold">{t('student.average')} : {data.average_20} / 20</span>}
      </header>
      <main className="mx-auto grid max-w-6xl gap-4 p-6 md:grid-cols-[1fr_300px]">
        <section className={card}>
          <h2 className="mb-2 font-semibold">{t('student.assignments')}</h2>
          {!data?.assignments.length && <p className="text-muted">{t('student.none')}</p>}
          <table className="w-full text-[13px]">
            <tbody>
              {data?.assignments.map((a) => (
                <tr key={a.id} className="border-t border-line">
                  <td className="py-2"><b>{a.title}</b>{a.kind === 'incident' && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">{t('community.incident')}</span>}<div className="text-[11px] text-muted">{a.class_name}{a.exam ? ` · ${t('asg.exam')} ${a.duration_min} min` : ''}</div></td>
                  <td className="text-[12px] text-muted">{a.deadline ? new Date(a.deadline).toLocaleString() : a.due_at ? new Date(a.due_at).toLocaleString() : ''}</td>
                  <td className="text-[12px]">{a.attempts ? `${t('student.submitted')} (${a.attempts}${a.max_attempts ? `/${a.max_attempts}` : ''})` : t('student.todo')}</td>
                  <td className="font-semibold">{a.score !== undefined && a.score !== null ? `${a.score}/${a.max_score}` : ''}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="mr-2 rounded bg-accent px-2 py-1 text-white" onClick={() => void open(a)}>{t('home.open')}</button>
                    {a.attempts > 0 && <button className="text-accent" onClick={() => void api<Sub[]>('GET', `/assignments/${a.id}/my-submissions`).then((s) => setSubs({ item: a, subs: s }))}>{t('student.results')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {subs && (
            <div className="mt-4 rounded border border-line p-3 text-[12px]">
              <h3 className="mb-2 font-semibold">{subs.item.title}</h3>
              {subs.subs.map((s) => (
                <div key={s.id} className="mb-3">
                  <p className="font-medium">{t('student.attempt', { n: s.attempt })} — {s.score !== undefined ? `${s.score}/${s.max_score}` : s.status === 'done' ? t('student.hidden') : t('student.pending')}</p>
                  {s.feedback && <p className="italic text-accent2">{s.feedback}</p>}
                  <ul>{s.report?.results.map((r) => <li key={r.id} className={r.passed ? 'text-ok' : 'text-bad'}>{r.passed ? '✓' : '✗'} {r.message}{r.feedback ? ` — ${r.feedback}` : ''}</li>)}</ul>
                  {s.report?.hidden_summary && s.report.hidden_summary.count > 0 && <p className="text-muted">{t('student.hiddenTests', { p: s.report.hidden_summary.passed, n: s.report.hidden_summary.count })}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
        <aside className={card}>
          <h2 className="mb-2 font-semibold">{t('teacher.announcements')}</h2>
          <ul className="text-[12px]">{data?.announcements.map((a, i) => <li key={i} className="border-t border-line py-1">{a.text}</li>)}</ul>
          <div className="mt-4 flex flex-col gap-3"><LearningProgress /></div>
        </aside>
      </main>
    </div>
  );
}
