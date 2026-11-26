import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { AcademyPageHeader } from '../components/AcademyNav';
import { useT } from '../i18n';
import { createLocalProject } from '../projects';
import { useUi } from '../store';

interface CommunityItem {
  id: string;
  title: string;
  kind: 'exercise' | 'incident';
  summary: string;
  skill_codes: string[];
  created_at: string;
  status: string;
}

interface CommunityDetail extends CommunityItem {
  statement: string;
  initial_project: unknown;
}
interface Skill { id: string; fr: string; en: string }

const card = 'rounded-lg border border-line bg-panel p-4';

export function CommunityPage() {
  const t = useT();
  const me = useUi((s) => s.me);
  const locale = useUi((s) => s.locale);
  const toast = useUi((s) => s.toast);
  const [items, setItems] = useState<CommunityItem[]>([]);
  const [pending, setPending] = useState<CommunityItem[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (search = '') => {
    setLoading(true);
    setError(false);
    try {
      const path = search.trim() ? `/community?q=${encodeURIComponent(search.trim())}` : '/community';
      const [published, review, catalog] = await Promise.all([
        api<CommunityItem[]>('GET', path),
        me?.is_superadmin ? api<CommunityItem[]>('GET', '/community/moderation/pending') : Promise.resolve([]),
        api<Skill[]>('GET', '/skills'),
      ]);
      setItems(published);
      setPending(review);
      setSkills(catalog);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [me?.is_superadmin]);

  useEffect(() => { void reload(); }, [reload]);

  const open = async (item: CommunityItem) => {
    setBusy(true);
    try {
      setDetail(await api<CommunityDetail>('GET', `/community/${item.id}`));
    } catch {
      toast(t('community.detailError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const useTemplate = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await createLocalProject(`${detail.title} — ${t('community.copy')}`, detail.initial_project);
    } catch {
      toast(t('community.copyError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const moderate = async (status: 'approved' | 'rejected') => {
    if (!detail) return;
    setBusy(true);
    try {
      await api('POST', `/community/${detail.id}/moderate`, { status });
      setDetail(null);
      toast(t(status === 'approved' ? 'community.approved' : 'community.rejected'));
      await reload(query);
    } catch {
      toast(t('community.moderationError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const skillLabel = (code: string) => {
    const skill = skills.find((item) => item.id === code);
    return skill ? skill[locale] : code;
  };
  const canUse = !!me && (me.is_superadmin || me.memberships.some((membership) => membership.role !== 'student'));

  return (
    <div className="nl-scroll h-full overflow-auto">
      <AcademyPageHeader title={t('community.title')} />
      <main className="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className={card}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-[12px] text-muted">{t('community.description')}</p>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void reload(query); }}>
              <input aria-label={t('community.search')} className="w-48 rounded border border-line bg-panel2 px-2 py-1 text-[12px]" value={query} onChange={(event) => setQuery(event.target.value)} />
              <button className="rounded border border-line px-2 py-1 text-[12px]">{t('community.search')}</button>
            </form>
          </div>
          {loading && <p className="text-[12px] text-muted">{t('academy.loading')}</p>}
          {error && <p role="alert" className="text-[12px] text-bad">{t('community.loadError')}</p>}
          {!loading && !error && !items.length && <p className="text-[12px] text-muted">{t('community.empty')}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((item) => (
              <article key={item.id} className="rounded border border-line bg-panel2 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{item.title}</h2>
                    <p className="mt-1 text-[11px] text-muted">{t(item.kind === 'incident' ? 'community.incident' : 'community.exercise')}</p>
                  </div>
                  <button className="text-[11px] text-accent" disabled={busy} onClick={() => void open(item)}>{t('community.details')}</button>
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12px] text-muted">{item.summary}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.skill_codes.map((code) => <span key={code} className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px]">{skillLabel(code)}</span>)}
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          {detail && (
            <section className={card}>
              <div className="flex items-start gap-2">
                <h2 className="flex-1 font-semibold">{detail.title}</h2>
                <button aria-label={t('community.close')} className="text-muted" onClick={() => setDetail(null)}>×</button>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[12px]">{detail.statement || t('community.noDescription')}</p>
              <p className="mt-3 text-[11px] text-muted">{t(detail.kind === 'incident' ? 'community.incident' : 'community.exercise')}</p>
              {detail.status === 'pending' && <p className="mt-2 rounded bg-warn/10 p-2 text-[11px] text-warn">{t('community.pendingReview')}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button disabled={busy} className="rounded bg-accent px-3 py-1 text-[12px] text-white disabled:opacity-40" onClick={() => void useTemplate()}>{t('community.copy')}</button>
                {me?.is_superadmin && detail.status === 'pending' && <>
                  <button disabled={busy} className="rounded bg-ok px-3 py-1 text-[12px] text-white disabled:opacity-40" onClick={() => void moderate('approved')}>{t('community.approve')}</button>
                  <button disabled={busy} className="rounded bg-bad px-3 py-1 text-[12px] text-white disabled:opacity-40" onClick={() => void moderate('rejected')}>{t('community.reject')}</button>
                </>}
              </div>
              {!canUse && <p className="mt-2 text-[11px] text-muted">{t('community.practiceOnly')}</p>}
            </section>
          )}
          {me?.is_superadmin && (
            <section className={card}>
              <h2 className="mb-2 font-semibold">{t('community.moderation')}</h2>
              {!pending.length && <p className="text-[12px] text-muted">{t('community.noPending')}</p>}
              <ul className="flex flex-col gap-2 text-[12px]">
                {pending.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 border-t border-line pt-2">
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <button className="text-accent" disabled={busy} onClick={() => void open(item)}>{t('community.review')}</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail && <p className="text-[10px] text-muted">{t('community.publicWarning')}</p>}
        </aside>
      </main>
    </div>
  );
}
