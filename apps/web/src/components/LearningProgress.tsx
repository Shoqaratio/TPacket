import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useUi } from '../store';

interface SkillProgress {
  id: string;
  fr: string;
  en: string;
  progress: number | null;
  mastered_criteria: number;
  measured_criteria: number;
}

interface Achievements {
  points: number;
  completed_activities: number;
  badges: string[];
}

const badgeKeys: Record<string, [string, string]> = {
  first_steps: ['badges.firstSteps', 'badges.firstStepsHelp'],
  perfect_score: ['badges.perfect', 'badges.perfectHelp'],
  consistent_practice: ['badges.consistent', 'badges.consistentHelp'],
  incident_resolver: ['badges.incident', 'badges.incidentHelp'],
};

const card = 'rounded-lg border border-line bg-panel p-4';

export function LearningProgress() {
  const t = useT();
  const locale = useUi((s) => s.locale);
  const [skills, setSkills] = useState<SkillProgress[]>([]);
  const [achievements, setAchievements] = useState<Achievements | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<SkillProgress[]>('GET', '/me/skills'),
      api<Achievements>('GET', '/me/achievements'),
    ]).then(([progress, badges]) => {
      if (cancelled) return;
      setSkills(progress);
      setAchievements(badges);
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <section className={card}>
        <h2 className="mb-2 font-semibold">{t('badges.title')}</h2>
        {error && <p className="text-[12px] text-bad" role="alert">{t('badges.error')}</p>}
        {!error && achievements && <>
          <p className="text-[12px]"><b>{achievements.points}</b> {t('badges.points')} <span className="text-muted">· {achievements.completed_activities} {t('badges.activities')}</span></p>
          {achievements.badges.length
            ? <ul className="mt-2 flex flex-col gap-2 text-[12px]">{achievements.badges.map((id) => {
              const keys = badgeKeys[id];
              return keys ? <li key={id} className="rounded bg-accent/10 px-2 py-1"><b>{t(keys[0])}</b><p className="text-[11px] text-muted">{t(keys[1])}</p></li> : null;
            })}</ul>
            : <p className="mt-2 text-[11px] text-muted">{t('badges.none')}</p>}
        </>}
      </section>
      <section className={card}>
        <h2 className="mb-2 font-semibold">{t('skills.title')}</h2>
        {error && <p className="text-[12px] text-bad" role="alert">{t('badges.error')}</p>}
        {!error && <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li key={skill.id} className="text-[11px]">
              <div className="mb-1 flex justify-between gap-2">
                <span>{locale === 'fr' ? skill.fr : skill.en}</span>
                <span className="text-muted">{skill.progress === null ? t('skills.notMeasured') : `${skill.progress}%`}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-panel2">
                <div className="h-full rounded bg-accent" style={{ width: `${skill.progress ?? 0}%` }} />
              </div>
              {skill.measured_criteria > 0 && <p className="mt-0.5 text-muted">{t('skills.mastered', { mastered: skill.mastered_criteria, total: skill.measured_criteria })}</p>}
            </li>
          ))}
        </ul>}
      </section>
    </>
  );
}
