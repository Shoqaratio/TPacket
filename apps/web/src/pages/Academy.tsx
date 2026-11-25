import { BookOpen, Dumbbell, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { AcademyPageHeader } from '../components/AcademyNav';
import { useT } from '../i18n';
import { createLocalProject } from '../projects';
import { useUi } from '../store';

interface Exercise {
  id: string;
  title: string;
  latest_version_id: string | null;
  version: number | null;
  published: boolean;
  orgName: string;
}

interface ExerciseVersion {
  title: string;
  initial_project: unknown;
}

const card = 'rounded-lg border border-line bg-panel p-4';

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <section className={`${card} flex min-h-56 flex-col items-center justify-center gap-2 text-center`}>
      <span className="text-muted">{icon}</span>
      <h2 className="font-semibold">{title}</h2>
      <p className="max-w-lg text-[12px] text-muted">{description}</p>
    </section>
  );
}

export function CoursesPage() {
  const t = useT();
  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={t('academy.courses')} />
      <main className="mx-auto max-w-6xl p-6">
        <EmptyState icon={<BookOpen size={28} />} title={t('academy.coursesEmptyTitle')} description={t('academy.coursesEmpty')} />
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
    if (!exercise.latest_version_id) return;
    setOpening(exercise.id);
    try {
      const version = await api<ExerciseVersion>('GET', `/exercise-versions/${exercise.latest_version_id}`);
      await createLocalProject(`${version.title} — ${t('academy.practice')}`, version.initial_project);
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
        {loading ? <p className="text-muted">{t('academy.loading')}</p> : error ? (
          <div className={`${card} text-bad`} role="alert">{t('academy.loadError')}</div>
        ) : exercises.length === 0 ? (
          <EmptyState icon={<Dumbbell size={28} />} title={t('academy.exercisesEmptyTitle')} description={t('academy.exercisesEmpty')} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {exercises.map((exercise) => (
              <article key={exercise.id} className={card}>
                <div className="flex items-start gap-3">
                  <Dumbbell size={18} className="mt-0.5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{exercise.title}</h2>
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
        )}
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

