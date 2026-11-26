import { BookOpen, Dumbbell, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { AcademyPageHeader } from '../components/AcademyNav';
import { localizedText, starterCourses, starterExercises } from '../content/starterCurriculum';
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
  summary?: string;
  statement?: string;
  initialProject?: unknown;
}

interface ExerciseVersion {
  title: string;
  initial_project: unknown;
}

const card = 'rounded-lg border border-line bg-panel p-4';

export function CoursesPage() {
  const t = useT();
  const locale = useUi((s) => s.locale);
  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={t('academy.courses')} />
      <main className="mx-auto max-w-6xl p-6">
        <p className="mb-4 text-[12px] text-muted">{t('academy.starterCoursesDescription')}</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {starterCourses.map((course) => (
            <article key={course.id} className={card}>
              <div className="mb-3 flex items-start gap-3">
                <BookOpen size={19} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">{localizedText(course.title, locale)}</h2>
                  <p className="mt-1 text-[11px] text-muted">{t('academy.levelIntro')} · {course.durationMinutes} {t('academy.minutes')}</p>
                </div>
              </div>
              <p className="mb-3 text-[12px] text-muted">{localizedText(course.summary, locale)}</p>
              <h3 className="mb-1 text-[12px] font-medium">{t('academy.courseObjectives')}</h3>
              <ul className="mb-3 list-disc space-y-1 pl-5 text-[12px]">
                {course.objectives.map((objective) => <li key={objective.fr}>{localizedText(objective, locale)}</li>)}
              </ul>
              <details className="border-t border-line pt-3">
                <summary className="cursor-pointer text-[12px] font-medium text-accent">{t('academy.courseContents')}</summary>
                <div className="mt-3 flex flex-col gap-3">
                  {course.lessons.map((lesson, index) => (
                    <section key={lesson.title.fr} className="border-l-2 border-accent/40 pl-3">
                      <h4 className="text-[12px] font-semibold">{index + 1}. {localizedText(lesson.title, locale)}</h4>
                      <p className="mt-1 text-[12px] leading-relaxed text-muted">{localizedText(lesson.body, locale)}</p>
                      <p className="mt-2 rounded bg-panel2 px-2 py-1.5 text-[11px]"><b>{t('academy.takeaway')} :</b> {localizedText(lesson.takeaway, locale)}</p>
                    </section>
                  ))}
                </div>
              </details>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}

export function ExercisesPage() {
  const t = useT();
  const me = useUi((s) => s.me);
  const locale = useUi((s) => s.locale);
  const toast = useUi((s) => s.toast);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const builtInExercises = useMemo<Exercise[]>(() => starterExercises.map((exercise) => {
    const title = localizedText(exercise.title, locale);
    const statement = localizedText(exercise.statement, locale);
    return {
      id: `starter-${exercise.id}`,
      title,
      latest_version_id: null,
      version: 1,
      published: true,
      orgName: t('academy.starterPack'),
      summary: localizedText(exercise.summary, locale),
      statement,
      initialProject: exercise.makeProject(title, statement),
    };
  }), [locale]);

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
      if (exercise.initialProject) {
        await createLocalProject(`${exercise.title} — ${t('academy.practice')}`, exercise.initialProject);
      } else if (exercise.latest_version_id) {
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
        <div className="grid gap-3 md:grid-cols-2">
            {[...builtInExercises, ...exercises].map((exercise) => (
              <article key={exercise.id} className={card}>
                <div className="flex items-start gap-3">
                  <Dumbbell size={18} className="mt-0.5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{exercise.title}{exercise.kind === 'incident' && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">{t('community.incident')}</span>}</h2>
                    <p className="mt-1 text-[11px] text-muted">{exercise.orgName} · {exercise.version ? `v${exercise.version}` : t('academy.noVersion')}</p>
                    {exercise.summary && <p className="mt-2 text-[12px] text-muted">{exercise.summary}</p>}
                    {exercise.statement && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-accent">{t('academy.exerciseInstructions')}</summary>
                        <pre className="mt-2 whitespace-pre-wrap rounded bg-panel2 p-2 text-[11px] font-sans">{exercise.statement}</pre>
                      </details>
                    )}
                    {!exercise.published && <span className="mt-2 inline-block rounded bg-panel2 px-2 py-0.5 text-[10px] text-muted">{t('academy.draft')}</span>}
                  </div>
                  <button
                    disabled={(!exercise.latest_version_id && !exercise.initialProject) || opening === exercise.id}
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

