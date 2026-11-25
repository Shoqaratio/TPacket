import { CABLE_TYPES, MODELS, type ModelSpec } from '@netlab/engine';
import { useT } from '../i18n';
import { useUi } from '../store';
import { CABLE_STYLE, DeviceIcon } from './icons';

const GROUPS: { key: string; filter: (m: ModelSpec) => boolean }[] = [
  { key: 'lib.routers', filter: (m) => m.kind === 'router' },
  { key: 'lib.switches', filter: (m) => m.kind === 'switch' || m.kind === 'l3switch' },
  { key: 'lib.hubs', filter: (m) => m.kind === 'hub' },
  { key: 'lib.wireless', filter: (m) => m.kind === 'ap' },
  { key: 'lib.end', filter: (m) => m.kind === 'host' },
];

export function Library() {
  const t = useT();
  const { tool, set } = useUi();
  const models = Object.values(MODELS);
  return (
    <aside className="nl-scroll flex w-[196px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel" aria-label={t('lib.devices')}>
      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{t('lib.devices')}</div>
      {GROUPS.map((g) => (
        <section key={g.key} className="px-2 pb-2">
          <h3 className="px-1 pb-1 text-[11px] text-muted">{t(g.key)}</h3>
          <div className="grid grid-cols-2 gap-1">
            {models.filter(g.filter).map((m) => (
              <button
                key={m.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-netlab-model', m.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title={`${m.label} — ${t('lib.dragHint')}`}
                className="flex cursor-grab flex-col items-center rounded border border-transparent p-1 hover:border-line hover:bg-panel2 active:cursor-grabbing"
              >
                <DeviceIcon kind={m.kind} role={m.role} size={34} />
                <span className="w-full truncate text-center text-[10px] leading-tight">{m.label.replace('Catalyst ', '').replace(' (multilayer)', ' L3')}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{t('lib.cables')}</div>
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {(['auto', ...CABLE_TYPES] as const).map((c) => {
          const active = tool.kind === 'cable' && tool.cable === c;
          const st = c === 'auto' ? { color: '#facc15' } : CABLE_STYLE[c]!;
          return (
            <button
              key={c}
              aria-pressed={active}
              onClick={() => set({ tool: active ? { kind: 'select' } : { kind: 'cable', cable: c } })}
              className={`flex items-center gap-2 rounded px-2 py-1 text-left text-[12px] ${active ? 'bg-accent text-white' : 'hover:bg-panel2'}`}
            >
              <svg width="28" height="10" aria-hidden>
                <line x1="2" y1="5" x2="26" y2="5" stroke={st.color} strokeWidth="2.5" strokeDasharray={'dash' in st ? st.dash : undefined} />
              </svg>
              {t(`cable.${c}`)}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
