import { MODELS } from '@netlab/engine';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { sim, useSim } from '../sim/client';
import { useUi } from '../store';
import { HostIpForm, useFail } from './DeviceWindow';
import { LIGHT_COLOR } from './icons';

export function Properties({ project }: { project: string }) {
  const t = useT();
  const fail = useFail();
  const { selection, set } = useUi();
  const view = useSim((s) => s.views[project]);
  const dev = selection.length === 1 ? view?.devices.find((d) => d.id === selection[0]) : undefined;
  const [name, setName] = useState('');
  useEffect(() => setName(dev?.name ?? ''), [dev?.id, dev?.name]);

  return (
    <aside className="nl-scroll flex w-[256px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel p-3" aria-label={t('props.title')}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{t('props.title')}</h2>
      {!dev ? (
        <p className="text-[12px] text-muted">{selection.length > 1 ? t('props.multi', { n: selection.length }) : t('props.none')}</p>
      ) : (
        <div className="flex flex-col gap-3 text-[12px]">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted">{t('props.name')}</span>
            <input className="rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== dev.name && void sim.op(project, 'renameDevice', dev.id, name).catch(fail)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t('props.model')}</dt>
            <dd>{MODELS[dev.model]!.label}</dd>
            {dev.kind !== 'host' && dev.kind !== 'hub' && (
              <>
                <dt className="text-muted">{t('props.hostname')}</dt>
                <dd className="font-mono">{dev.hostname}</dd>
              </>
            )}
            <dt className="text-muted">{t('props.power')}</dt>
            <dd>
              <button className={`rounded px-2 text-white ${dev.powered ? 'bg-ok' : 'bg-slate-600'}`} onClick={() => void sim.op(project, 'setPower', dev.id, !dev.powered)}>
                {dev.powered ? t('props.on') : t('props.off')}
              </button>
            </dd>
          </dl>
          {dev.modified && <p className="rounded bg-warn/15 px-2 py-1 text-warn">{t('props.unsaved')}</p>}
          {dev.ipConflict && <p className="rounded bg-bad/15 px-2 py-1 text-bad">{t('props.conflict')}</p>}
          {dev.loadErrors.length > 0 && (
            <details className="rounded bg-bad/10 px-2 py-1 text-bad">
              <summary>{t('props.loadErrors')} ({dev.loadErrors.length})</summary>
              <pre className="whitespace-pre-wrap text-[11px]">{dev.loadErrors.join('\n')}</pre>
            </details>
          )}
          <div className="flex gap-2">
            <button className="rounded bg-accent px-2 py-1 text-white" onClick={() => set({ windowDevice: dev.id })}>{t('props.open')}</button>
            {dev.kind !== 'hub' && <button className="rounded border border-line px-2 py-1" onClick={() => set({ cliDevice: dev.id })}>CLI</button>}
          </div>
          {dev.kind === 'host' && <HostIpForm project={project} dev={dev} />}
          <div>
            <h3 className="mb-1 text-muted">{t('props.interfaces')}</h3>
            <ul className="flex flex-col gap-0.5">
              {dev.ports.filter((p) => p.media !== 'console' && p.media !== 'rs232').map((p) => (
                <li key={p.name} className="flex items-center gap-2" title={p.status}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: LIGHT_COLOR[p.light] }} aria-hidden />
                  <span className="truncate">{p.name.replace('GigabitEthernet', 'Gi').replace('FastEthernet', 'Fa')}</span>
                  <span className="ml-auto font-mono text-[10px] text-accent">{p.ip ?? ''}</span>
                  <span className="sr-only">{p.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </aside>
  );
}
