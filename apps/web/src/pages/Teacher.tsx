import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useT } from '../i18n';
import { createLocalProject } from '../projects';
import { useUi } from '../store';

interface Dashboard {
  students: number;
  classes: number;
  graded_submissions: number;
  to_review: number;
  success_rate: number | null;
  per_class: { class_id: string; name: string; average_20: number | null; graded: number }[];
  hardest: { criterion: string; failures: number }[];
  recent: { action: string; at: string }[];
}
interface OrgOption { id: string; name: string; slug: string }
interface ClassRow { id: string; name: string; academic_year: string; archived: boolean }
interface Exercise { id: string; title: string; latest_version_id: string | null; version: number | null; published: boolean; kind?: 'exercise' | 'incident' }
interface AssignmentRow { id: string; title: string; due_at: string | null; exam: boolean; duration_min: number | null; max_attempts: number; results: string; max_score: number | null; kind?: 'exercise' | 'incident' }
interface ClassDetail { id: string; name: string; academic_year: string; members: { user_id: string; display_name: string; email?: string; role: string }[]; assignments: AssignmentRow[]; announcements: { id: string; text: string; created_at: string }[] }
interface SubRow { student_id: string; display_name: string; attempts: number; submission_id: string | null; submitted_at: string | null; score: number | null; max_score: number | null; session_events: number; late: boolean; failed: string[] }

const input = 'rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';
const card = 'rounded-lg border border-line bg-panel p-4';

function orgSlug(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className={card}><div className="text-[11px] uppercase text-muted">{label}</div><div className="text-[22px] font-semibold">{value}</div></div>;
}

function Submissions({ a, onClose }: { a: AssignmentRow; onClose(): void }) {
  const t = useT();
  const toast = useUi((s) => s.toast);
  const [rows, setRows] = useState<SubRow[]>([]);
  const reload = useCallback(() => void api<SubRow[]>('GET', `/assignments/${a.id}/submissions`).then(setRows), [a.id]);
  useEffect(reload, [reload]);
  const openSnapshot = async (sid: string, name: string) => {
    const s = await api<{ snapshot: unknown }>('GET', `/submissions/${sid}`);
    await createLocalProject(`${a.title} — ${name} (${t('teacher.snapshot')})`, s.snapshot);
  };
  const override = async (r: SubRow) => {
    const score = prompt(t('teacher.newScore', { m: r.max_score ?? '' }), String(r.score ?? ''));
    if (score === null) return;
    const reason = prompt(t('teacher.reason'));
    if (!reason) return;
    const feedback = prompt(t('teacher.feedback')) ?? '';
    try {
      await api('POST', `/submissions/${r.submission_id}/override`, { score: Number(score), reason, feedback });
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.code : 'error', 'error');
    }
  };
  return (
    <section className={card}>
      <div className="mb-2 flex items-center gap-2"><button onClick={onClose} aria-label="back"><ArrowLeft size={14} /></button><h3 className="font-semibold">{a.title}</h3><button className="ml-auto rounded border border-line px-2 py-0.5" onClick={reload}>{t('teacher.refresh')}</button></div>
      <table className="w-full text-[12px]">
        <thead className="text-left text-muted"><tr><th>{t('teacher.student')}</th><th>{t('teacher.attempts')}</th><th>{t('teacher.score')}</th><th>{t('teacher.failed')}</th><th>{t('teacher.events')}</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.student_id} className="border-t border-line">
              <td className="py-1">{r.display_name}{r.late && <span className="ml-1 rounded bg-warn/20 px-1 text-warn">{t('teacher.late')}</span>}</td>
              <td>{r.attempts}</td>
              <td>{r.score !== null ? `${r.score} / ${r.max_score}` : r.submission_id ? '…' : '—'}</td>
              <td className="text-muted">{r.failed.join(', ')}</td>
              <td title={t('teacher.eventsHelp')}>{r.session_events || ''}</td>
              <td className="whitespace-nowrap text-right">
                {r.submission_id && <>
                  <button className="mr-2 text-accent" onClick={() => void openSnapshot(r.submission_id!, r.display_name)}>{t('teacher.open')}</button>
                  <button className="text-accent" onClick={() => void override(r)}>{t('teacher.override')}</button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ClassView({ cid, exercises, onBack }: { cid: string; exercises: Exercise[]; onBack(): void }) {
  const t = useT();
  const toast = useUi((s) => s.toast);
  const [c, setC] = useState<ClassDetail | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [sel, setSel] = useState<AssignmentRow | null>(null);
  const [form, setForm] = useState({ exercise_version_id: '', title: '', due_at: '', exam: false, duration_min: 60, max_attempts: 0, allow_checks: true, allow_tutor: true, results: 'immediate' });
  const [ann, setAnn] = useState('');
  const [member, setMember] = useState('');
  const reload = useCallback(() => void api<ClassDetail>('GET', `/classes/${cid}`).then(setC), [cid]);
  useEffect(reload, [reload]);
  if (!c) return null;
  if (sel) return <Submissions a={sel} onClose={() => setSel(null)} />;
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/classes/${cid}/assignments`, {
        ...form,
        due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
        duration_min: form.exam ? form.duration_min : null,
        allow_checks: form.exam ? false : form.allow_checks,
      });
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? t(`teacher.err.${err.code}`) : 'error', 'error');
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2"><button onClick={onBack} aria-label="back"><ArrowLeft size={16} /></button><h2 className="text-[16px] font-semibold">{c.name} <span className="text-muted">{c.academic_year}</span></h2></div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h3 className="mb-2 font-semibold">{t('teacher.members')} ({c.members.length})</h3>
          <div className="mb-2 flex gap-2">
            <button className="rounded border border-line px-2 py-1" onClick={() => void api<{ code: string }>('POST', `/classes/${cid}/join-code`).then((r) => setCode(r.code))}>{t('teacher.joinCode')}</button>
            {code && <code className="rounded bg-accent2/15 px-2 py-1 text-[14px] font-bold tracking-widest">{code}</code>}
          </div>
          <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void api('POST', `/classes/${cid}/members`, { email: member, role: 'student' }).then(() => { setMember(''); reload(); }, () => toast(t('teacher.err.user_not_in_org'), 'error')); }}>
            <input className={`${input} flex-1`} type="email" placeholder={t('auth.email')} value={member} onChange={(e) => setMember(e.target.value)} />
            <button className="rounded border border-line px-2">{t('svc.add')}</button>
          </form>
          <ul className="nl-scroll max-h-48 overflow-auto text-[12px]">{c.members.map((m) => <li key={m.user_id}>{m.display_name} <span className="text-muted">{m.email} · {m.role}</span></li>)}</ul>
        </section>
        <section className={card}>
          <h3 className="mb-2 font-semibold">{t('teacher.announcements')}</h3>
          <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (ann.trim()) void api('POST', `/classes/${cid}/announcements`, { text: ann }).then(() => { setAnn(''); reload(); }); }}>
            <input className={`${input} flex-1`} value={ann} onChange={(e) => setAnn(e.target.value)} />
            <button className="rounded border border-line px-2">{t('teacher.publish')}</button>
          </form>
          <ul className="text-[12px]">{c.announcements.map((a) => <li key={a.id} className="border-t border-line py-1">{a.text}</li>)}</ul>
        </section>
      </div>
      <section className={card}>
        <h3 className="mb-2 font-semibold">{t('teacher.assignments')}</h3>
        <table className="mb-3 w-full text-[12px]">
          <tbody>{c.assignments.map((a) => (
            <tr key={a.id} className="border-t border-line">
              <td className="py-1"><button className="font-medium text-accent" onClick={() => setSel(a)}>{a.title}</button>{a.kind === 'incident' && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">{t('community.incident')}</span>}</td>
              <td>{a.exam ? `${t('asg.exam')} · ${a.duration_min ?? '—'} min` : t('asg.assignment')}</td>
              <td className="text-muted">{a.due_at ? new Date(a.due_at).toLocaleString() : ''}</td>
              <td className="text-muted">{a.max_attempts ? `${a.max_attempts} ${t('teacher.attempts')}` : '∞'}</td>
            </tr>
          ))}</tbody>
        </table>
        <form className="grid grid-cols-4 gap-2 text-[12px]" onSubmit={create}>
          <select required className={input} value={form.exercise_version_id} onChange={(e) => { const ex = exercises.find((x) => x.latest_version_id === e.target.value); setForm({ ...form, exercise_version_id: e.target.value, title: form.title || ex?.title || '' }); }}>
            <option value="">{t('teacher.chooseExercise')}</option>
            {exercises.filter((x) => x.published).map((x) => <option key={x.id} value={x.latest_version_id!}>{x.kind === 'incident' ? `${t('community.incident')}: ` : ''}{x.title} (v{x.version})</option>)}
          </select>
          <input required className={input} placeholder={t('ex.name')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <label className="flex items-center gap-1">{t('teacher.due')}<input type="datetime-local" className={input} value={form.due_at} onChange={(e) => setForm({ ...form, due_at: e.target.value })} /></label>
          <label className="flex items-center gap-1">{t('teacher.attempts')}<input type="number" min={0} className={`${input} w-16`} value={form.max_attempts} onChange={(e) => setForm({ ...form, max_attempts: Number(e.target.value) })} /></label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={form.exam} onChange={(e) => setForm({ ...form, exam: e.target.checked })} />{t('asg.exam')}</label>
          {form.exam && <label className="flex items-center gap-1">{t('teacher.duration')}<input type="number" min={1} className={`${input} w-16`} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })} /> min</label>}
          {!form.exam && <label className="flex items-center gap-1"><input type="checkbox" checked={form.allow_checks} onChange={(e) => setForm({ ...form, allow_checks: e.target.checked })} />{t('teacher.allowChecks')}</label>}
          <label className="flex items-center gap-1"><input type="checkbox" checked={form.allow_tutor} onChange={(e) => setForm({ ...form, allow_tutor: e.target.checked })} />{t('teacher.allowTutor')}</label>
          <select className={input} value={form.results} onChange={(e) => setForm({ ...form, results: e.target.value })}>
            {['immediate', 'after_due', 'never'].map((r) => <option key={r} value={r}>{t(`teacher.results.${r}`)}</option>)}
          </select>
          <button className="rounded bg-accent px-3 py-1 text-white">{t('teacher.createAssignment')}</button>
        </form>
      </section>
    </div>
  );
}

export function TeacherPage() {
  const t = useT();
  const { me, set, toast } = useUi();
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [org, setOrg] = useState('');
  const [orgLoading, setOrgLoading] = useState(true);
  const [orgLoadError, setOrgLoadError] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgCreateError, setOrgCreateError] = useState<string | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const year = new Date().getMonth() >= 7 ? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}` : `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;

  useEffect(() => {
    let cancelled = false;
    setOrgLoading(true);
    setOrgLoadError(false);
    void (async () => {
      try {
        const rows = me?.is_superadmin
          ? await api<OrgOption[]>('GET', '/orgs')
          : (me?.memberships ?? []).filter((m) => m.role !== 'student').map((m) => ({ id: m.org_id, name: m.org_name, slug: '' }));
        if (cancelled) return;
        setOrgs(rows);
        setOrg((current) => rows.some((item) => item.id === current) ? current : rows[0]?.id ?? '');
      } catch {
        if (!cancelled) setOrgLoadError(true);
      } finally {
        if (!cancelled) setOrgLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [me]);

  const reload = useCallback(() => {
    if (!org) {
      setDash(null);
      setClasses([]);
      setExercises([]);
      return;
    }
    void Promise.all([
      api<Dashboard>('GET', `/orgs/${org}/dashboard`),
      api<ClassRow[]>('GET', `/orgs/${org}/classes`),
      api<Exercise[]>('GET', `/orgs/${org}/exercises`),
    ]).then(([nextDash, nextClasses, nextExercises]) => {
      setDash(nextDash);
      setClasses(nextClasses);
      setExercises(nextExercises);
    }).catch((err: unknown) => {
      toast(err instanceof ApiError ? t(`teacher.err.${err.code}`) : t('teacher.actionError'), 'error');
    });
  }, [org, toast]);
  useEffect(reload, [reload]);

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = orgName.trim();
    if (!trimmed) return;
    setCreatingOrg(true);
    setOrgCreateError(null);
    try {
      const created = await api<OrgOption>('POST', '/orgs', { name: trimmed, slug: orgSlug(trimmed) });
      setOrgs((current) => [...current, created]);
      setOrg(created.id);
      setOrgName('');
    } catch (err) {
      setOrgCreateError(err instanceof ApiError ? t(`teacher.err.${err.code}`) : t('teacher.actionError'));
    } finally {
      setCreatingOrg(false);
    }
  };

  const createClass = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!org || !trimmed) return;
    try {
      await api('POST', `/orgs/${org}/classes`, { name: trimmed, academic_year: year });
      setName('');
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? t(`teacher.err.${err.code}`) : t('teacher.actionError'), 'error');
    }
  };

  return (
    <div className="nl-scroll h-full overflow-auto">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-6 py-3">
        <button onClick={() => set({ page: 'home' })} aria-label="back"><ArrowLeft size={16} /></button>
        <h1 className="text-[16px] font-semibold">{t('teacher.title')}</h1>
        <select aria-label={t('teacher.chooseOrg')} className={input} value={org} disabled={orgLoading || orgs.length === 0} onChange={(e) => setOrg(e.target.value)}>
          <option value="">{orgLoading ? t('teacher.loadingOrganizations') : t('teacher.chooseOrg')}</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
        {orgLoadError && <p className={`${card} text-bad`} role="alert">{t('teacher.orgLoadError')}</p>}
        {!orgLoading && !orgLoadError && orgs.length === 0 && (
          me?.is_superadmin ? (
            <section className={card}>
              <h2 className="mb-2 font-semibold">{t('teacher.createOrganization')}</h2>
              <p className="mb-3 text-[12px] text-muted">{t('teacher.noOrgHint')}</p>
              <form className="flex gap-2" onSubmit={(e) => void createOrg(e)}>
                <input aria-label={t('teacher.orgName')} required minLength={2} className={`${input} flex-1`} placeholder={t('teacher.orgNamePlaceholder')} value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                <button disabled={creatingOrg} className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50">{creatingOrg ? t('academy.loading') : t('teacher.createOrganization')}</button>
              </form>
              {orgCreateError && <p className="mt-2 text-[12px] text-bad" role="alert">{orgCreateError}</p>}
            </section>
          ) : <p className={`${card} text-muted`}>{t('teacher.noOrganizations')}</p>
        )}
        {open ? <ClassView cid={open} exercises={exercises} onBack={() => { setOpen(null); reload(); }} /> : (
          <>
            {dash && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label={t('teacher.students')} value={dash.students} />
                <Stat label={t('teacher.classes')} value={dash.classes} />
                <Stat label={t('teacher.graded')} value={dash.graded_submissions} />
                <Stat label={t('teacher.toReview')} value={dash.to_review} />
                <Stat label={t('teacher.success')} value={dash.success_rate !== null ? `${dash.success_rate} %` : '—'} />
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <section className={card}>
                <h2 className="mb-2 font-semibold">{t('teacher.classes')}</h2>
                {!org && !orgLoading && !orgLoadError && !me?.is_superadmin && <p className="mb-3 text-[12px] text-muted">{t('teacher.noOrganizations')}</p>}
                <ul className="mb-3">{classes.map((c) => {
                  const pc = dash?.per_class.find((x) => x.class_id === c.id);
                  return <li key={c.id} className="flex justify-between border-t border-line py-1"><button className="text-accent" onClick={() => setOpen(c.id)}>{c.name}</button><span className="text-muted">{c.academic_year} · {t('teacher.avg')} {pc?.average_20 ?? '—'}/20</span></li>;
                })}</ul>
                <form className="flex gap-2" onSubmit={(e) => void createClass(e)}>
                  <input required disabled={!org || orgLoading} className={`${input} flex-1 disabled:opacity-50`} placeholder={t('teacher.className')} value={name} onChange={(e) => setName(e.target.value)} />
                  <button disabled={!org || orgLoading} className="rounded bg-accent px-3 text-white disabled:opacity-50">{t('teacher.createClass')}</button>
                </form>
              </section>
              <section className={card}>
                <h2 className="mb-2 font-semibold">{t('teacher.hardest')}</h2>
                {dash?.hardest.length ? <ul className="text-[12px]">{dash.hardest.map((h) => <li key={h.criterion} className="flex justify-between border-t border-line py-1"><span>{h.criterion}</span><span className="text-bad">{h.failures}</span></li>)}</ul> : <p className="text-muted">—</p>}
                <h2 className="mb-2 mt-4 font-semibold">{t('teacher.exercises')}</h2>
                <ul className="text-[12px]">{exercises.map((x) => <li key={x.id} className="border-t border-line py-1">{x.title} <span className="text-muted">v{x.version ?? 0}{x.published ? '' : ` · ${t('teacher.draft')}`}</span></li>)}</ul>
                <p className="mt-2 text-[11px] text-muted">{t('teacher.exerciseHint')}</p>
                <button disabled={!org} className="mt-2 rounded border border-line px-3 py-1 text-[12px] disabled:opacity-50" onClick={() => set({ page: 'home' })}>{t('teacher.openProjectForExercise')}</button>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
