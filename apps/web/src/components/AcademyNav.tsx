import { useT } from '../i18n';
import type { Me } from '../api';
import type { Page } from '../store';
import { useUi } from '../store';

const items: { page: Page; label: string }[] = [
  { page: 'home', label: 'academy.dashboard' },
  { page: 'student', label: 'academy.activities' },
  { page: 'courses', label: 'academy.courses' },
  { page: 'exercises', label: 'academy.exercises' },
  { page: 'profile', label: 'academy.profile' },
];

export function AcademyNav({ current, me }: { current: Page; me: Me | null }) {
  const t = useT();
  const set = useUi((s) => s.set);
  const canTeach = !!me && (me.is_superadmin || me.memberships.some((m) => m.role !== 'student'));

  return (
    <nav aria-label={t('academy.navigation')} className="flex gap-1 overflow-x-auto border-b border-line bg-panel px-6 py-2">
      {items.map(({ page, label }) => (
        <button
          key={page}
          aria-current={current === page ? 'page' : undefined}
          className={`shrink-0 rounded px-3 py-1.5 text-[12px] transition-all duration-200 hover:-translate-y-px ${current === page ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-panel2 hover:text-fg'}`}
          onClick={() => set({ page })}
        >
          {t(label)}
        </button>
      ))}
      {canTeach && (
        <button
          aria-current={current === 'teacher' ? 'page' : undefined}
          className={`shrink-0 rounded px-3 py-1.5 text-[12px] transition-all duration-200 hover:-translate-y-px ${current === 'teacher' ? 'bg-accent2/15 font-medium text-accent2' : 'text-muted hover:bg-panel2 hover:text-fg'}`}
          onClick={() => set({ page: 'teacher' })}
        >
          {t('teacher.title')}
        </button>
      )}
    </nav>
  );
}

export function AcademyPageHeader({ current, me, title }: { current: Page; me: Me | null; title: string }) {
  return (
    <>
      <header className="border-b border-line bg-panel px-6 py-3">
        <h1 className="text-[16px] font-semibold">{title}</h1>
      </header>
      <AcademyNav current={current} me={me} />
    </>
  );
}
