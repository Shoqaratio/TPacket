import { BookOpen, Dumbbell, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { AcademyPageHeader } from '../components/AcademyNav';
import { useT } from '../i18n';
import { createLocalProject } from '../projects';
import { useUi } from '../store';

interface Exercise {
  id: string;
  title: string;
  kind?: 'exercise' | 'incident';
  latest_version_id: string | null;
  version: number | null;
  published: boolean;
  orgName: string;
}

interface ExerciseVersion {
  title: string;
  initial_project: unknown;
}

interface CourseLesson {
  title: string;
  body: string;
  takeaway: string;
}

interface Course {
  id: string;
  org_id: string;
  orgName: string;
  title: string;
  summary: string;
  duration_minutes: number;
  objectives: string[];
  lessons: CourseLesson[];
}

interface CourseOrg {
  id: string;
  name: string;
}

const card = 'rounded-lg border border-line bg-panel p-4';
const input = 'rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';

function CourseReader({ course, onBack }: { course: Course; onBack: () => void }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const lessonHeading = useRef<HTMLHeadingElement>(null);
  const lesson = course.lessons[index];
  const showLesson = (next: number) => {
    setIndex(next);
    lessonHeading.current?.focus();
  };

  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={course.title} />
      <main className="mx-auto max-w-6xl p-6">
        <button type="button" className="mb-4 text-accent hover:underline" onClick={onBack}>{t('academy.backToCourses')}</button>
        <div className={`${card} mb-4`}>
          <p className="text-[12px] text-muted">{course.orgName} · {course.duration_minutes} {t('academy.minutes')}</p>
          <p className="mt-2 whitespace-pre-wrap">{course.summary}</p>
          <h2 className="mt-3 font-semibold">{t('academy.courseObjectives')}</h2>
          <ul className="list-disc pl-5">{course.objectives.map((objective, i) => <li key={i}>{objective}</li>)}</ul>
        </div>
        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label={t('academy.courseLessons')} className={`${card} self-start`}>
            <h2 className="mb-2 font-semibold">{t('academy.courseLessons')}</h2>
            <ol className="space-y-1">
              {course.lessons.map((item, i) => (
                <li key={i}>
                  <button type="button" aria-current={index === i ? 'step' : undefined} className="w-full break-words rounded px-2 py-1.5 text-left hover:bg-panel2 aria-[current=step]:bg-accent/15 aria-[current=step]:text-accent" onClick={() => showLesson(i)}>
                    {i + 1}. {item.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          {lesson && (
            <article className={card}>
              <h2 ref={lessonHeading} tabIndex={-1} className="break-words text-lg font-semibold" aria-live="polite">{index + 1}. {lesson.title}</h2>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{lesson.body}</p>
              {lesson.takeaway && <p className="mt-4 whitespace-pre-wrap break-words rounded bg-panel2 p-3"><strong>{t('academy.takeaway')}</strong> · {lesson.takeaway}</p>}
              <div className="mt-4 flex flex-wrap justify-between gap-2 border-t border-line pt-3">
                <button type="button" className={`${input} disabled:opacity-40`} disabled={index === 0} onClick={() => showLesson(index - 1)}>{t('academy.previousLesson')}</button>
                <button type="button" className={`${input} disabled:opacity-40`} disabled={index === course.lessons.length - 1} onClick={() => showLesson(index + 1)}>{t('academy.nextLesson')}</button>
              </div>
            </article>
          )}
        </div>
      </main>
    </div>
  );
}

export function CoursesPage() {
  const t = useT();
  const me = useUi((s) => s.me);
  const toast = useUi((s) => s.toast);
  const [orgs, setOrgs] = useState<CourseOrg[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [coursesError, setCoursesError] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [duration, setDuration] = useState(45);
  const [objectives, setObjectives] = useState('');
  const [lessons, setLessons] = useState<CourseLesson[]>([{ title: '', body: '', takeaway: '' }]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const writableOrgs = useMemo(() => me?.is_superadmin
    ? orgs
    : orgs.filter((org) => me?.memberships.some((membership) => membership.org_id === org.id && membership.role !== 'student')),
  [me?.is_superadmin, me?.memberships, orgs]);

  useEffect(() => {
    let cancelled = false;
    if (!me) {
      setOrgs([]);
      setCourses([]);
      setLoadingCourses(false);
      return () => { cancelled = true; };
    }

    setLoadingCourses(true);
    setCoursesError(false);
    void api<CourseOrg[]>('GET', '/orgs').then(async (availableOrgs) => {
      if (cancelled) return;
      setOrgs(availableOrgs);
      const byOrg = await Promise.all(availableOrgs.map(async (org) => {
        const rows = await api<Omit<Course, 'orgName'>[]>('GET', `/orgs/${org.id}/courses`);
        return rows.map((course) => ({ ...course, orgName: org.name }));
      }));
      if (!cancelled) setCourses(byOrg.flat());
    }).catch(() => {
      if (!cancelled) setCoursesError(true);
    }).finally(() => {
      if (!cancelled) setLoadingCourses(false);
    });
    return () => { cancelled = true; };
  }, [me]);

  useEffect(() => {
    setOrgId((current) => writableOrgs.some((org) => org.id === current) ? current : writableOrgs[0]?.id ?? '');
  }, [writableOrgs]);

  const createCourse = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanObjectives = objectives.split('\n').map((item) => item.trim()).filter(Boolean);
    const cleanLessons = lessons.map((lesson) => ({
      title: lesson.title.trim(),
      body: lesson.body.trim(),
      takeaway: lesson.takeaway.trim(),
    }));
    if (!orgId || !title.trim() || !summary.trim() || !cleanObjectives.length || cleanLessons.some((lesson) => !lesson.title || !lesson.body)) return;

    setCreating(true);
    setCreateError(false);
    try {
      const created = await api<Omit<Course, 'orgName'>>('POST', `/orgs/${orgId}/courses`, {
        title: title.trim(),
        summary: summary.trim(),
        duration_minutes: duration,
        objectives: cleanObjectives,
        lessons: cleanLessons,
      });
      const orgName = orgs.find((org) => org.id === orgId)?.name ?? '';
      setCourses((current) => [ { ...created, orgName }, ...current ]);
      setTitle('');
      setSummary('');
      setDuration(45);
      setObjectives('');
      setLessons([{ title: '', body: '', takeaway: '' }]);
      toast(t('academy.courseCreated'));
    } catch {
      setCreateError(true);
    } finally {
      setCreating(false);
    }
  };

  const updateLesson = (index: number, field: keyof CourseLesson, value: string) => {
    setLessons((current) => current.map((lesson, i) => i === index ? { ...lesson, [field]: value } : lesson));
  };

  const selectedCourse = courses.find((course) => course.id === selectedCourseId);
  if (selectedCourse) return <CourseReader key={selectedCourse.id} course={selectedCourse} onBack={() => setSelectedCourseId(null)} />;

  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={t('academy.courses')} />
      <main className="mx-auto max-w-6xl p-6">
        {writableOrgs.length > 0 && (
          <section className={`${card} mb-4`}>
            <h2 className="mb-3 font-semibold">{t('academy.createCourse')}</h2>
            <form className="flex flex-col gap-3" onSubmit={(event) => void createCourse(event)}>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-[12px]">
                  <span className="text-muted">{t('academy.courseOrganization')}</span>
                  <select required className={input} value={orgId} onChange={(event) => setOrgId(event.target.value)}>
                    {writableOrgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[12px]">
                  <span className="text-muted">{t('academy.courseTitle')}</span>
                  <input required maxLength={200} className={input} value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted">{t('academy.courseSummary')}</span>
                <textarea required maxLength={4000} className={`${input} min-h-16`} value={summary} onChange={(event) => setSummary(event.target.value)} />
              </label>
              <label className="flex max-w-xs flex-col gap-1 text-[12px]">
                <span className="text-muted">{t('academy.courseDuration')}</span>
                <input required type="number" min={1} max={1440} className={input} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
              </label>
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted">{t('academy.courseObjectivesInput')}</span>
                <textarea required className={`${input} min-h-20`} value={objectives} onChange={(event) => setObjectives(event.target.value)} placeholder={t('academy.courseObjectivesPlaceholder')} />
              </label>
              <div className="flex flex-col gap-2">
                <h3 className="text-[12px] font-medium">{t('academy.courseLessons')}</h3>
                {lessons.map((lesson, index) => (
                  <fieldset key={index} className="flex flex-col gap-2 rounded border border-line p-3">
                    <legend className="px-1 text-[11px] text-muted">{t('academy.courseLessonNumber', { n: index + 1 })}</legend>
                    <input required maxLength={200} aria-label={t('academy.courseLessonTitle')} className={input} value={lesson.title} onChange={(event) => updateLesson(index, 'title', event.target.value)} placeholder={t('academy.courseLessonTitle')} />
                    <textarea required maxLength={20000} aria-label={t('academy.courseLessonBody')} className={`${input} min-h-28`} value={lesson.body} onChange={(event) => updateLesson(index, 'body', event.target.value)} placeholder={t('academy.courseLessonBody')} />
                    <input maxLength={4000} aria-label={t('academy.courseTakeaway')} className={input} value={lesson.takeaway} onChange={(event) => updateLesson(index, 'takeaway', event.target.value)} placeholder={t('academy.courseTakeaway')} />
                    {lessons.length > 1 && <button type="button" className="self-start text-[11px] text-bad" onClick={() => setLessons((current) => current.filter((_, i) => i !== index))}>{t('academy.removeLesson')}</button>}
                  </fieldset>
                ))}
                <button type="button" className="self-start rounded border border-line px-3 py-1 text-[12px]" onClick={() => setLessons((current) => [...current, { title: '', body: '', takeaway: '' }])}>{t('academy.addLesson')}</button>
              </div>
              {createError && <p className="text-[12px] text-bad" role="alert">{t('academy.courseCreateError')}</p>}
              <button disabled={creating || !orgId} className="self-start rounded bg-accent px-3 py-1.5 text-[12px] text-white disabled:opacity-50">
                {creating ? t('academy.loading') : t('academy.createCourse')}
              </button>
            </form>
          </section>
        )}
        {coursesError && <p className={`${card} mb-4 text-bad`} role="alert">{t('academy.courseLoadError')}</p>}
        {courses.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 text-[15px] font-semibold">{t('academy.organizationCourses')}</h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {courses.map((course) => (
                <article key={course.id} className={card}>
                  <h3 className="font-semibold">
                    <button type="button" className="flex w-full items-center gap-2 text-left text-accent hover:underline" onClick={() => setSelectedCourseId(course.id)}>
                      <BookOpen size={18} className="shrink-0" />
                      {course.title}
                    </button>
                  </h3>
                  <p className="mt-1 text-[11px] text-muted">{course.orgName} · {course.duration_minutes} {t('academy.minutes')}</p>
                  <p className="mt-2 text-[12px] text-muted">{course.summary}</p>
                </article>
              ))}
            </div>
          </section>
        )}
        {loadingCourses && <p className="mb-4 text-[12px] text-muted">{t('academy.loading')}</p>}
        {!loadingCourses && !coursesError && courses.length === 0 && <p className={card}>{t('academy.noCourses')}</p>}
      </main>
    </div>
  );
}

export function ExercisesPage() {
  const t = useT();
  const me = useUi((s) => s.me);
  const toast = useUi((s) => s.toast);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const memberships = me?.memberships ?? [];
    setLoading(true);
    setError(false);
    if (memberships.length === 0) {
      setExercises([]);
      setLoading(false);
      return () => { cancelled = true; };
    }

    void Promise.all(memberships.map(async (membership) => {
      const rows = await api<Omit<Exercise, 'orgName'>[]>('GET', `/orgs/${membership.org_id}/exercises`);
      return rows.map((exercise) => ({ ...exercise, orgName: membership.org_name }));
    })).then((rows) => {
      if (!cancelled) setExercises(rows.flat());
    }).catch(() => {
      if (!cancelled) setError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [me]);

  const openExercise = async (exercise: Exercise) => {
    setOpening(exercise.id);
    try {
      if (exercise.latest_version_id) {
        const version = await api<ExerciseVersion>('GET', `/exercise-versions/${exercise.latest_version_id}`);
        await createLocalProject(`${version.title} — ${t('academy.practice')}`, version.initial_project);
      }
    } catch {
      toast(t('academy.exerciseOpenError'), 'error');
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={t('academy.exercises')} />
      <main className="mx-auto max-w-6xl p-6">
        <p className="mb-4 text-[12px] text-muted">{t('academy.exercisesDescription')}</p>
        {loading && <p className="mb-3 text-[12px] text-muted">{t('academy.loading')}</p>}
        {error && <div className={`${card} mb-3 text-bad`} role="alert">{t('academy.loadError')}</div>}
        {!loading && !error && exercises.length === 0 && <p className={card}>{t('academy.noExercises')}</p>}
        <div className="grid gap-3 md:grid-cols-2">
            {exercises.map((exercise) => (
              <article key={exercise.id} className={card}>
                <div className="flex items-start gap-3">
                  <Dumbbell size={18} className="mt-0.5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{exercise.title}{exercise.kind === 'incident' && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">{t('community.incident')}</span>}</h2>
                    <p className="mt-1 text-[11px] text-muted">{exercise.orgName} · {exercise.version ? `v${exercise.version}` : t('academy.noVersion')}</p>
                    {!exercise.published && <span className="mt-2 inline-block rounded bg-panel2 px-2 py-0.5 text-[10px] text-muted">{t('academy.draft')}</span>}
                  </div>
                  <button
                    disabled={!exercise.latest_version_id || opening === exercise.id}
                    className="shrink-0 rounded bg-accent px-3 py-1.5 text-[12px] text-white hover:brightness-110 disabled:opacity-40"
                    onClick={() => void openExercise(exercise)}
                  >
                    {opening === exercise.id ? t('academy.loading') : t('academy.practice')}
                  </button>
                </div>
              </article>
            ))}
        </div>
      </main>
    </div>
  );
}

export function ProfilePage() {
  const t = useT();
  const me = useUi((s) => s.me);
  if (!me) return null;
  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={t('academy.profile')} />
      <main className="mx-auto grid max-w-6xl gap-4 p-6 md:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <section className={card}>
          <div className="mb-4 flex items-center gap-3">
            <UserRound size={20} className="text-accent" />
            <h2 className="font-semibold">{t('academy.account')}</h2>
          </div>
          <dl className="grid gap-3 text-[13px] sm:grid-cols-[150px_1fr]">
            <dt className="text-muted">{t('auth.name')}</dt><dd>{me.display_name}</dd>
            <dt className="text-muted">{t('auth.email')}</dt><dd>{me.email}</dd>
          </dl>
        </section>
        <section className={card}>
          <h2 className="mb-3 font-semibold">{t('academy.memberships')}</h2>
          {me.memberships.length ? (
            <ul className="flex flex-col gap-2 text-[12px]">
              {me.memberships.map((membership) => (
                <li key={membership.org_id} className="flex justify-between gap-3 border-t border-line pt-2">
                  <span>{membership.org_name}</span>
                  <span className="text-muted">{t(`academy.role.${membership.role}`)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-[12px] text-muted">{t('academy.noMemberships')}</p>}
        </section>
      </main>
    </div>
  );
}

