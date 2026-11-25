import * as Dialog from '@radix-ui/react-dialog';
import { CRITERION_TYPES, type Criterion, type GradeReport } from '@netlab/engine';
import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { sim, useSim } from '../sim/client';
import { storage, type StoredProject } from '../storage';
import { useUi } from '../store';

type Field = { key: string; kind: 'device' | 'text' | 'number' | 'select'; options?: string[] };

/** Fields of each criterion type, so teachers never write JSON. */
const FIELDS: Record<string, Field[]> = {
  device_exists: [{ key: 'device', kind: 'device' }, { key: 'model', kind: 'text' }],
  device_count: [{ key: 'kind', kind: 'select', options: ['', 'router', 'switch', 'l3switch', 'host', 'hub', 'ap'] }, { key: 'min', kind: 'number' }, { key: 'max', kind: 'number' }],
  link_exists: [{ key: 'a', kind: 'device' }, { key: 'b', kind: 'device' }],
  hostname: [{ key: 'device', kind: 'device' }, { key: 'expected', kind: 'text' }],
  interface_address: [{ key: 'device', kind: 'device' }, { key: 'interface', kind: 'text' }, { key: 'expected', kind: 'text' }],
  interface_up: [{ key: 'device', kind: 'device' }, { key: 'interface', kind: 'text' }],
  host_config: [{ key: 'device', kind: 'device' }, { key: 'field', kind: 'select', options: ['ip', 'mask', 'gateway', 'dns'] }, { key: 'expected', kind: 'text' }],
  route_exists: [{ key: 'device', kind: 'device' }, { key: 'destination', kind: 'text' }, { key: 'via', kind: 'select', options: ['any', 'static', 'connected', 'rip', 'ospf'] }],
  connectivity_test: [{ key: 'source', kind: 'device' }, { key: 'destination', kind: 'device' }, { key: 'expected', kind: 'select', options: ['success', 'failure'] }],
  configuration_saved: [{ key: 'device', kind: 'device' }],
  vlan_exists: [{ key: 'device', kind: 'device' }, { key: 'vlan', kind: 'number' }, { key: 'name', kind: 'text' }],
  switchport_access: [{ key: 'device', kind: 'device' }, { key: 'interface', kind: 'text' }, { key: 'vlan', kind: 'number' }],
  switchport_trunk: [{ key: 'device', kind: 'device' }, { key: 'interface', kind: 'text' }],
  enable_secret: [{ key: 'device', kind: 'device' }],
  line_password: [{ key: 'device', kind: 'device' }, { key: 'line', kind: 'select', options: ['con', 'vty'] }, { key: 'login', kind: 'select', options: ['line', 'local'] }],
  password_encryption: [{ key: 'device', kind: 'device' }],
  acl_applied: [{ key: 'device', kind: 'device' }, { key: 'interface', kind: 'text' }, { key: 'direction', kind: 'select', options: ['in', 'out'] }, { key: 'acl', kind: 'text' }],
  dhcp_client: [{ key: 'device', kind: 'device' }],
  service_access: [{ key: 'source', kind: 'device' }, { key: 'destination', kind: 'device' }, { key: 'service', kind: 'select', options: ['http', 'https', 'telnet', 'ssh'] }, { key: 'expected', kind: 'select', options: ['allowed', 'denied'] }],
  dns_resolution: [{ key: 'source', kind: 'device' }, { key: 'name', kind: 'text' }, { key: 'expected', kind: 'text' }],
  ipv6_connectivity: [{ key: 'source', kind: 'device' }, { key: 'destination', kind: 'device' }, { key: 'expected', kind: 'select', options: ['success', 'failure'] }],
};

type Row = Record<string, string | number | boolean | string[] | undefined> & { id: string; type: string; points: number };

function toCriterion(r: Row): Criterion {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === '' || v === undefined || (k === 'via' && v === 'any')) continue;
    out[k] = ['vlan', 'min', 'max', 'points'].includes(k) ? Number(v) : v;
  }
  return out as unknown as Criterion;
}

export function ExerciseEditor({ project, onClose }: { project: string; onClose(): void }) {
  const t = useT();
  const me = useUi((s) => s.me);
  const toast = useUi((s) => s.toast);
  const view = useSim((s) => s.views[project]);
  const orgs = (me?.memberships ?? []).filter((m) => m.role !== 'student');
  const [org, setOrg] = useState(orgs[0]?.org_id ?? '');
  const [title, setTitle] = useState(view?.name ?? '');
  const [statement, setStatement] = useState('');
  const [maxScore, setMaxScore] = useState(20);
  const [rows, setRows] = useState<Row[]>([{ id: 'c1', type: 'connectivity_test', points: 5, expected: 'success' }]);
  const [initial, setInitial] = useState<string>('');
  const [projects, setProjects] = useState<StoredProject[]>([]);
  const [report, setReport] = useState<GradeReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void storage.list().then(setProjects), []);
  const devices = view?.devices.map((d) => d.name) ?? [];
  const rubric = { title, maxScore, criteria: rows.map(toCriterion) };
  const total = rows.filter((r) => !r.bonus && !r.penalty).reduce((s, r) => s + Number(r.points), 0);
  const input = 'rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';
  const set = (i: number, k: string, v: Row[string]) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const test = async () => {
    setReport(await sim.grade(project, rubric));
  };

  const publish = async () => {
    setBusy(true);
    try {
      const rep = await sim.grade(project, rubric);
      setReport(rep);
      // Feasibility: the reference solution (this project) must obtain full marks.
      if (rep.score < maxScore) return toast(t('ex.notFeasible'), 'error');
      const init = initial ? (await storage.get(initial))?.doc : await sim.serialize(project);
      const ex = await api<{ id: string }>('POST', `/orgs/${org}/exercises`, { title });
      await api('POST', `/exercises/${ex.id}/versions`, { statement, initial_project: init, rubric, publish: true });
      toast(t('ex.published'));
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="nl-scroll fixed left-1/2 top-1/2 z-50 flex max-h-[94vh] w-[980px] max-w-[98vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-lg border border-line bg-panel p-5 text-[12px] shadow-2xl">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold">{t('ex.title')}</Dialog.Title>
            <Dialog.Close aria-label="close"><X size={16} /></Dialog.Close>
          </div>
          <p className="text-muted">{t('ex.help')}</p>
          {orgs.length === 0 && <p className="text-bad">{t('ex.needOrg')}</p>}
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-0.5"><span className="text-muted">{t('ex.org')}</span><select className={input} value={org} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o) => <option key={o.org_id} value={o.org_id}>{o.org_name}</option>)}</select></label>
            <label className="flex flex-col gap-0.5"><span className="text-muted">{t('ex.name')}</span><input className={input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label className="flex flex-col gap-0.5"><span className="text-muted">{t('ex.initial')}</span>
              <select className={input} value={initial} onChange={(e) => setInitial(e.target.value)}>
                <option value="">{t('ex.initialSame')}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
          </div>
          <label className="flex flex-col gap-0.5"><span className="text-muted">{t('ex.statement')}</span><textarea className={`${input} h-28`} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={t('ex.statementPh')} /></label>
          <div className="flex items-center gap-3">
            <h3 className="font-semibold">{t('ex.criteria')}</h3>
            <label className="flex items-center gap-1 text-muted">{t('ex.maxScore')}<input type="number" className={`${input} w-16`} value={maxScore} min={1} onChange={(e) => setMaxScore(Number(e.target.value) || 20)} /></label>
            <span className={total === maxScore ? 'text-ok' : 'text-warn'}>{t('ex.total', { n: total })}</span>
          </div>
          <table className="w-full">
            <thead className="text-left text-muted"><tr><th>{t('ex.id')}</th><th>{t('ex.type')}</th><th>{t('ex.params')}</th><th>{t('ex.points')}</th><th>{t('ex.flags')}</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-line align-top">
                  <td className="py-1 pr-1"><input className={`${input} w-20`} value={r.id} onChange={(e) => set(i, 'id', e.target.value)} /></td>
                  <td className="py-1 pr-1"><select className={input} value={r.type} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { id: x.id, type: e.target.value, points: x.points } : x)))}>
                    {CRITERION_TYPES.map((ty) => <option key={ty} value={ty}>{t(`crit.${ty}`)}</option>)}</select></td>
                  <td className="py-1 pr-1"><div className="flex flex-wrap gap-1">
                    {(FIELDS[r.type] ?? []).map((f) => f.kind === 'select' ? (
                      <select key={f.key} aria-label={f.key} className={input} value={String(r[f.key] ?? '')} onChange={(e) => set(i, f.key, e.target.value)}>{f.options!.map((o) => <option key={o} value={o}>{o || '—'}</option>)}</select>
                    ) : (
                      <input key={f.key} aria-label={f.key} placeholder={t(`ex.f.${f.key}`)} list={f.kind === 'device' ? 'ex-devices' : undefined} type={f.kind === 'number' ? 'number' : 'text'} className={`${input} w-32`} value={String(r[f.key] ?? '')} onChange={(e) => set(i, f.key, e.target.value)} />
                    ))}
                  </div></td>
                  <td className="py-1 pr-1"><input type="number" className={`${input} w-14`} value={r.points} min={0} onChange={(e) => set(i, 'points', Number(e.target.value))} /></td>
                  <td className="py-1 pr-1"><div className="flex flex-col">
                    {(['required', 'hidden', 'bonus', 'penalty'] as const).map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={!!r[k]} onChange={(e) => set(i, k, e.target.checked)} />{t(`ex.${k}`)}</label>)}
                  </div></td>
                  <td><button aria-label={t('edit.delete')} className="text-bad" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="ex-devices">{devices.map((d) => <option key={d} value={d} />)}</datalist>
          <button className="flex items-center gap-1 self-start rounded border border-line px-2 py-1" onClick={() => setRows([...rows, { id: `c${rows.length + 1}`, type: 'route_exists', points: 2 }])}><Plus size={14} />{t('ex.add')}</button>
          {report && (
            <div className="rounded border border-line p-3">
              <p className="mb-1 font-semibold">{t('ex.testResult', { s: report.score, m: report.maxScore })}</p>
              <ul>{report.results.map((r) => <li key={r.id} className={r.passed ? 'text-ok' : 'text-bad'}>{r.passed ? '✓' : '✗'} {r.id}: {r.message}</li>)}</ul>
            </div>
          )}
          <div className="flex gap-2">
            <button className="rounded border border-line px-3 py-1" onClick={() => void test()}>{t('ex.test')}</button>
            <button disabled={busy || !org || !title} className="rounded bg-accent px-3 py-1 text-white disabled:opacity-40" onClick={() => void publish()}>{t('ex.publish')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
