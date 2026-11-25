import * as DM from '@radix-ui/react-dropdown-menu';
import { useReactFlow } from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { FastForward, Footprints, Hand, MousePointer2, Pause, Play, RotateCcw, Square, StickyNote, Trash2, Undo2, Redo2, Mail } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { createLocalProject, downloadFile, exportNetlab, importNetlabFile } from '../projects';
import { sim, useSim } from '../sim/client';
import { useUi } from '../store';
import { ENGINE_VERSION } from '@netlab/engine';
import { ExerciseEditor } from './ExerciseEditor';

async function exportImage(kind: 'png' | 'svg' | 'pdf', name: string, fit: () => void) {
  fit();
  await new Promise((r) => setTimeout(r, 350));
  const el = document.querySelector<HTMLElement>('.react-flow');
  if (!el) return;
  const filter = (n: HTMLElement) => !n.classList?.contains('react-flow__minimap') && !n.classList?.contains('react-flow__controls') && !n.classList?.contains('react-flow__panel');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--nl-canvas').trim() || '#0a1120';
  if (kind === 'svg') {
    const url = await toSvg(el, { filter, backgroundColor: bg });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.svg`;
    a.click();
    return;
  }
  const url = await toPng(el, { filter, backgroundColor: bg, pixelRatio: 2 });
  if (kind === 'png') {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.png`;
    a.click();
    return;
  }
  const { jsPDF } = await import('jspdf');
  const w = el.clientWidth;
  const h = el.clientHeight;
  const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'px', format: [w, h] });
  pdf.addImage(url, 'PNG', 0, 0, w, h);
  downloadFile(`${name}.pdf`, pdf.output('arraybuffer'), 'application/pdf');
}

export function MenuBar({ project }: { project: string }) {
  const t = useT();
  const ui = useUi();
  const view = useSim((s) => s.views[project]);
  const rf = useReactFlow();
  const file = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState(false);
  const staff = !!ui.me?.memberships.some((m) => m.role !== 'student');
  const name = view?.name ?? 'projet';
  const fit = () => rf.fitView({ padding: 0.15, maxZoom: 1.5 });
  const devSel = ui.selection.filter((id) => view?.devices.some((d) => d.id === id));

  const align = (axis: 'row' | 'col') => {
    const ds = view!.devices.filter((d) => devSel.includes(d.id)).sort((a, b) => (axis === 'row' ? a.x - b.x : a.y - b.y));
    if (ds.length < 2) return;
    const ref = axis === 'row' ? ds[0]!.y : ds[0]!.x;
    const step = 120;
    const start = axis === 'row' ? ds[0]!.x : ds[0]!.y;
    void sim.op(project, 'moveDevices', ds.map((d, i) => (axis === 'row' ? { id: d.id, x: start + i * step, y: ref } : { id: d.id, x: ref, y: start + i * step })));
  };

  return (
    <nav className="flex h-7 items-center gap-0.5 border-b border-line bg-panel px-2 text-[12.5px]" aria-label="menu">
      <span className="mr-2 font-semibold text-accent">TPacket</span>
      <Menu label={t('menu.file')}>
        <MI onSelect={() => void createLocalProject(t('file.new'))}>{t('file.new')}</MI>
        <MI onSelect={() => file.current?.click()}>{t('file.open')}</MI>
        <MI onSelect={() => void exportNetlab(project)} kbd="Ctrl+S">{t('file.save')}</MI>
        <MI onSelect={() => { const n = prompt(t('file.rename'), name); if (n?.trim()) void sim.op(project, 'rename', n.trim()); }}>{t('file.rename')}</MI>
        <Sep />
        <MI onSelect={() => void exportImage('png', name, fit)}>{t('file.exportPng')}</MI>
        <MI onSelect={() => void exportImage('svg', name, fit)}>{t('file.exportSvg')}</MI>
        <MI onSelect={() => void exportImage('pdf', name, fit)}>{t('file.exportPdf')}</MI>
        {staff && <MI onSelect={() => setEditor(true)}>{t('ex.create')}</MI>}
        <Sep />
        <MI onSelect={() => ui.set({ active: null })}>{t('file.home')}</MI>
      </Menu>
      <Menu label={t('menu.edit')}>
        <MI disabled={!view?.canUndo} onSelect={() => void sim.undo(project)} kbd="Ctrl+Z">{t('edit.undo')}</MI>
        <MI disabled={!view?.canRedo} onSelect={() => void sim.redo(project)} kbd="Ctrl+Y">{t('edit.redo')}</MI>
        <Sep />
        <MI disabled={!devSel.length} onSelect={() => void sim.op<string[]>(project, 'duplicate', devSel, 40, 40).then((ids) => ui.set({ selection: ids }))} kbd="Ctrl+D">{t('edit.duplicate')}</MI>
        <MI disabled={!ui.selection.length} onSelect={() => void sim.op(project, 'removeItems', ui.selection).then(() => ui.set({ selection: [] }))} kbd="Suppr">{t('edit.delete')}</MI>
        <MI onSelect={() => ui.set({ selection: [...(view?.devices.map((d) => d.id) ?? []), ...(view?.notes.map((n) => n.id) ?? [])] })} kbd="Ctrl+A">{t('edit.selectAll')}</MI>
        <Sep />
        <MI disabled={devSel.length < 2} onSelect={() => align('row')}>{ui.locale === 'fr' ? 'Aligner horizontalement' : 'Align in a row'}</MI>
        <MI disabled={devSel.length < 2} onSelect={() => align('col')}>{ui.locale === 'fr' ? 'Aligner verticalement' : 'Align in a column'}</MI>
      </Menu>
      <Menu label={t('menu.view')}>
        <MI onSelect={() => ui.set({ theme: ui.theme === 'dark' ? 'light' : 'dark' })}>{t('view.theme')}</MI>
        <MI onSelect={() => ui.set({ locale: ui.locale === 'fr' ? 'en' : 'fr' })}>{t('view.language')}</MI>
        <Sep />
        <Check on={ui.showPorts} onSelect={() => ui.set({ showPorts: !ui.showPorts })}>{t('view.ports')}</Check>
        <Check on={ui.showIps} onSelect={() => ui.set({ showIps: !ui.showIps })}>{t('view.ips')}</Check>
        <Check on={ui.snap} onSelect={() => ui.set({ snap: !ui.snap })}>{t('view.grid')}</Check>
        <Check on={ui.minimap} onSelect={() => ui.set({ minimap: !ui.minimap })}>{t('view.minimap')}</Check>
        <Sep />
        <MI onSelect={fit}>{t('view.fit')}</MI>
        <MI onSelect={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())} kbd="F11">{t('view.fullscreen')}</MI>
      </Menu>
      <Menu label={t('menu.help')}>
        <MI onSelect={() => alert(`TPacket — engine ${ENGINE_VERSION}\n\nSimulateur réseau pédagogique indépendant. Aucun logiciel Cisco n'est inclus ; « Cisco », « IOS » et « Packet Tracer » sont des marques de Cisco Systems, citées à titre de compatibilité.`)}>
          À propos / About
        </MI>
      </Menu>
      {editor && <ExerciseEditor project={project} onClose={() => setEditor(false)} />}
      <input ref={file} type="file" accept=".netlab,application/json" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void importNetlabFile(f).catch(() => ui.toast(t('err.invalidFile'), 'error'));
        e.target.value = '';
      }} />
    </nav>
  );
}

export function Toolbar({ project }: { project: string }) {
  const t = useT();
  const ui = useUi();
  const view = useSim((s) => s.views[project]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(700);

  useEffect(() => {
    if (ui.mode !== 'realtime') return;
    const h = setInterval(() => void sim.tick(project, 1000), 1000);
    return () => clearInterval(h);
  }, [ui.mode, project]);

  useEffect(() => {
    if (!playing || ui.mode !== 'simulation') return;
    const h = setInterval(() => {
      void sim.simStep(project).then((more) => !more && setPlaying(false));
    }, speed);
    return () => clearInterval(h);
  }, [playing, speed, ui.mode, project]);

  const tool = (k: 'select' | 'note' | 'zone' | 'pdu') => ui.set({ tool: { kind: k } as never });
  const is = (k: string) => ui.tool.kind === k;
  const B = ({ on, label, onClick, children, disabled }: { on?: boolean; label: string; onClick(): void; children: React.ReactNode; disabled?: boolean }) => (
    <button title={label} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick} className={`flex h-7 w-7 items-center justify-center rounded ${on ? 'bg-accent text-white' : 'hover:bg-panel2'} disabled:opacity-35`}>
      {children}
    </button>
  );
  return (
    <div className="flex h-9 items-center gap-1 border-b border-line bg-panel px-2" role="toolbar">
      <B label={t('tool.select')} on={is('select')} onClick={() => tool('select')}><MousePointer2 size={16} /></B>
      <B label={t('tool.note')} on={is('note')} onClick={() => tool('note')}><StickyNote size={16} /></B>
      <B label={t('tool.zone')} on={is('zone')} onClick={() => tool('zone')}><Square size={16} /></B>
      <B label={t('tool.delete')} disabled={!ui.selection.length} onClick={() => void sim.op(project, 'removeItems', ui.selection).then(() => ui.set({ selection: [] }))}><Trash2 size={16} /></B>
      <div className="mx-1 h-5 w-px bg-line" />
      <B label={t('edit.undo')} disabled={!view?.canUndo} onClick={() => void sim.undo(project)}><Undo2 size={16} /></B>
      <B label={t('edit.redo')} disabled={!view?.canRedo} onClick={() => void sim.redo(project)}><Redo2 size={16} /></B>
      <div className="mx-1 h-5 w-px bg-line" />
      <div className="flex overflow-hidden rounded border border-line text-[12px]" role="radiogroup">
        {(['realtime', 'simulation'] as const).map((m) => (
          <button key={m} role="radio" aria-checked={ui.mode === m} onClick={() => { setPlaying(false); ui.set({ mode: m, tool: { kind: 'select' } }); }} className={`px-2.5 py-1 ${ui.mode === m ? 'bg-accent2 text-white' : 'hover:bg-panel2'}`}>
            {t(`mode.${m}`)}
          </button>
        ))}
      </div>
      {ui.mode === 'realtime' ? (
        <B label={t('sim.fastForward')} onClick={() => void sim.tick(project, 30_000)}><FastForward size={16} /></B>
      ) : (
        <>
          <B label={t('sim.addPdu')} on={is('pdu')} onClick={() => tool(is('pdu') ? 'select' : 'pdu')}><Mail size={16} /></B>
          <B label={playing ? t('sim.pause') : t('sim.play')} on={playing} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={16} /> : <Play size={16} />}</B>
          <B label={t('sim.step')} onClick={() => void sim.simStep(project)}><Footprints size={16} /></B>
          <B label={t('sim.reset')} onClick={() => { setPlaying(false); void sim.simReset(project); }}><RotateCcw size={16} /></B>
          <label className="ml-1 flex items-center gap-1 text-[11px] text-muted">
            {t('sim.speed')}
            <input type="range" min={150} max={1500} step={50} value={1650 - speed} onChange={(e) => setSpeed(1650 - Number(e.target.value))} aria-label={t('sim.speed')} />
          </label>
          <span className="text-[11px] text-muted">{view?.pending ?? 0} ⧗</span>
        </>
      )}
      <div className="flex-1" />
      <Hand size={14} className="text-muted" aria-hidden />
      <span className="text-[11px] text-muted">{ui.locale === 'fr' ? 'Molette : zoom · Glisser le fond : déplacer · Shift+glisser : sélection' : 'Wheel: zoom · Drag background: pan · Shift+drag: select'}</span>
    </div>
  );
}

function Menu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DM.Root>
      <DM.Trigger className="rounded px-2 py-0.5 outline-none hover:bg-panel2 data-[state=open]:bg-panel2">{label}</DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={2} className="z-50 min-w-60 rounded-md border border-line bg-panel py-1 text-[12.5px] shadow-xl">{children}</DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function MI({ children, onSelect, kbd, disabled }: { children: React.ReactNode; onSelect(): void; kbd?: string; disabled?: boolean }) {
  return (
    <DM.Item disabled={!!disabled} onSelect={onSelect} className="flex cursor-default items-center justify-between gap-6 px-3 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-white">
      <span>{children}</span>
      {kbd && <span className="text-[11px] opacity-60">{kbd}</span>}
    </DM.Item>
  );
}

function Check({ children, on, onSelect }: { children: React.ReactNode; on: boolean; onSelect(): void }) {
  return (
    <DM.CheckboxItem checked={on} onSelect={(e) => { e.preventDefault(); onSelect(); }} className="flex cursor-default items-center gap-2 px-3 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-white">
      <span className="w-3">{on ? '✓' : ''}</span>
      {children}
    </DM.CheckboxItem>
  );
}

function Sep() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}
