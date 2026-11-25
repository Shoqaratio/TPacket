import { ENGINE_VERSION } from '@netlab/engine';
import { ReactFlowProvider } from '@xyflow/react';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { closeProject, exportNetlab, openProject, saveAsCloudCopy, useSave } from '../projects';
import { sim, useSim } from '../sim/client';
import { useUi } from '../store';
import { BottomPanel } from './BottomPanel';
import { Canvas } from './Canvas';
import { DeviceWindow } from './DeviceWindow';
import { Library } from './Library';
import { MenuBar, Toolbar } from './MenuBar';
import { Properties } from './Properties';
import { AssignmentBar } from './AssignmentBar';

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('[data-terminal]'));
}

function useShortcuts(project: string) {
  const clip = useRef<string[]>([]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || document.querySelector('[role="dialog"]')) return;
      const ui = useUi.getState();
      const view = useSim.getState().views[project];
      const mod = e.ctrlKey || e.metaKey;
      const devSel = ui.selection.filter((id) => view?.devices.some((d) => d.id === id));
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) void sim.undo(project);
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) void sim.redo(project);
      else if (mod && e.key.toLowerCase() === 'c') clip.current = devSel;
      else if (mod && e.key.toLowerCase() === 'v' && clip.current.length) void sim.op<string[]>(project, 'duplicate', clip.current.filter((id) => view?.devices.some((d) => d.id === id)), 60, 60).then((ids) => ui.set({ selection: ids }));
      else if (mod && e.key.toLowerCase() === 'd' && devSel.length) void sim.op<string[]>(project, 'duplicate', devSel, 40, 40).then((ids) => ui.set({ selection: ids }));
      else if (mod && e.key.toLowerCase() === 'a') ui.set({ selection: [...(view?.devices.map((d) => d.id) ?? []), ...(view?.notes.map((n) => n.id) ?? [])] });
      else if (mod && e.key.toLowerCase() === 's') void exportNetlab(project);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selection.length) void sim.op(project, 'removeItems', ui.selection).then(() => ui.set({ selection: [] }));
      else if (e.key === 'Escape') ui.set({ tool: { kind: 'select' } });
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [project]);
}

function StatusBar({ project }: { project: string }) {
  const t = useT();
  const view = useSim((s) => s.views[project]);
  const mode = useUi((s) => s.mode);
  const save = useSave((s) => s.state[project] ?? 'saved');
  const secs = Math.floor((view?.now ?? 0) / 1000);
  const clock = `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <footer className="flex h-6 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted" role="status">
      <span>{t('status.mode')}: <b className="text-accent2">{t(`mode.${mode}`)}</b></span>
      <span>{t('status.time')}: <span className="font-mono">{clock}</span></span>
      <span>{view?.devices.length ?? 0} {t('status.devices')}</span>
      <span className={save === 'conflict' ? 'text-bad' : ''}>
        {t(`status.${save}`)}
        {save === 'conflict' && <button className="ml-2 underline" onClick={() => void saveAsCloudCopy(project)}>{useUi.getState().locale === 'fr' ? 'Enregistrer une copie' : 'Save a copy'}</button>}
      </span>
      <span className="ml-auto">engine {ENGINE_VERSION}</span>
    </footer>
  );
}

function Tabs() {
  const { tabs, active } = useUi();
  const views = useSim((s) => s.views);
  return (
    <div className="flex h-7 items-end gap-0.5 overflow-x-auto bg-bg px-1" role="tablist">
      {tabs.map((id) => (
        <div key={id} role="tab" aria-selected={id === active} className={`group flex max-w-48 items-center gap-1 rounded-t border border-b-0 px-2 py-0.5 text-[12px] ${id === active ? 'border-line bg-panel' : 'border-transparent text-muted hover:bg-panel2'}`}>
          <button className="truncate" onClick={() => void openProject(id)}>{views[id]?.name ?? '…'}</button>
          <button aria-label="close tab" className="rounded opacity-60 hover:bg-panel2 hover:opacity-100" onClick={() => void closeProject(id)}><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

export function Workspace({ project }: { project: string }) {
  useShortcuts(project);
  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <MenuBar project={project} />
        <Tabs />
        <Toolbar project={project} />
        <AssignmentBar project={project} />
        <div className="flex min-h-0 flex-1">
          <Library />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1"><Canvas project={project} /></div>
            <BottomPanel project={project} />
          </main>
          <Properties project={project} />
        </div>
        <StatusBar project={project} />
      </div>
      <DeviceWindow project={project} />
    </ReactFlowProvider>
  );
}
