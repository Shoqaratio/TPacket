import * as CM from '@radix-ui/react-context-menu';
import type { CableType, SimEvent } from '@netlab/engine';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeResizer,
  Position,
  ReactFlow,
  useReactFlow,
  ViewportPortal,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { SimError, sim, useSim } from '../sim/client';
import type { DeviceView, PortView } from '../sim/protocol';
import { useUi } from '../store';
import { sendCursor, useCollab } from '../collab';
import { CABLE_STYLE, DeviceIcon, LIGHT_COLOR } from './icons';

const NODE_W = 72;
const NODE_H = 64;

type DeviceData = { dev: DeviceView; showIps: boolean };
type NoteData = { id: string; text: string; color: string; project: string };
type ZoneData = { id: string; label: string; color: string; project: string };

const DeviceNode = memo(function DeviceNode({ data, selected }: NodeProps<Node<DeviceData>>) {
  const d = data.dev;
  return (
    <div className={`flex w-[72px] flex-col items-center rounded-md px-1 pt-1 ${selected ? 'bg-accent/15 ring-2 ring-accent' : ''}`} title={`${d.name} (${d.model})`}>
      <Handle type="source" position={Position.Top} className="!left-1/2 !top-[26px] !h-1 !w-1 !min-w-0 !border-0 !opacity-0" />
      <Handle type="target" position={Position.Top} className="!left-1/2 !top-[26px] !h-1 !w-1 !min-w-0 !border-0 !opacity-0" />
      <DeviceIcon kind={d.kind} role={d.role} size={44} off={!d.powered} />
      <div className="max-w-[120px] truncate text-center text-[11px] font-medium leading-tight text-fg">{d.name}</div>
      {data.showIps && d.ips.length > 0 && <div className="text-center font-mono text-[10px] leading-tight text-accent">{d.ips.slice(0, 3).map((ip) => <div key={ip}>{ip}</div>)}</div>}
      {d.ipConflict && <div className="mt-0.5 rounded bg-bad px-1 text-[9px] font-bold text-white">IP!</div>}
    </div>
  );
});

function NoteNode({ data, selected }: NodeProps<Node<NoteData>>) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(data.text);
  useEffect(() => setText(data.text), [data.text]);
  return (
    <div className={`min-w-[120px] max-w-[260px] rounded px-2 py-1 text-[12px] text-slate-900 shadow ${selected ? 'ring-2 ring-accent' : ''}`} style={{ background: data.color }} onDoubleClick={() => setEdit(true)}>
      {edit ? (
        <textarea
          autoFocus
          className="nodrag h-20 w-full resize bg-transparent outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEdit(false);
            if (text !== data.text) void sim.op(data.project, 'updateAnnotation', data.id, { text });
          }}
        />
      ) : (
        <div className="whitespace-pre-wrap">{data.text}</div>
      )}
    </div>
  );
}

function ZoneNode({ data, selected }: NodeProps<Node<ZoneData>>) {
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        lineClassName="!border-accent"
        onResizeEnd={(_, p) => void sim.op(data.project, 'updateAnnotation', data.id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
      />
      <div className="h-full w-full rounded-lg border-2 border-dashed" style={{ borderColor: data.color, background: `${data.color}14` }}>
        <div className="px-2 py-1 text-[12px] font-semibold" style={{ color: data.color }}>{data.label}</div>
      </div>
    </>
  );
}

type CableData = { cable: CableType; lightA: string; lightB: string; portA: string; portB: string; showPorts: boolean; offset: number };

function CableEdge({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<Edge<CableData>>) {
  const d = data!;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * d.offset;
  const ny = (dx / len) * d.offset;
  const sx = sourceX + nx;
  const sy = sourceY + ny;
  const tx = targetX + nx;
  const ty = targetY + ny;
  const style = CABLE_STYLE[d.cable]!;
  const at = (t: number) => [sx + (tx - sx) * t, sy + (ty - sy) * t] as const;
  const k = Math.min(0.35, 38 / len);
  const [ax, ay] = at(k);
  const [bx, by] = at(1 - k);
  const [lax, lay] = at(Math.min(0.42, 60 / len));
  const [lbx, lby] = at(1 - Math.min(0.42, 60 / len));
  return (
    <>
      <BaseEdge id={id} path={`M${sx},${sy} L${tx},${ty}`} style={{ stroke: selected ? 'var(--nl-accent)' : style.color, strokeWidth: selected ? 3 : 2, strokeDasharray: style.dash }} interactionWidth={14} />
      {d.cable.startsWith('serial') && <path d={`M${(sx + tx) / 2 - 6},${(sy + ty) / 2 - 6} l6,6 l-4,0 l6,6`} stroke={style.color} fill="none" strokeWidth={2} />}
      <circle cx={ax} cy={ay} r={4.5} fill={LIGHT_COLOR[d.lightA]} stroke="#0008" />
      <circle cx={bx} cy={by} r={4.5} fill={LIGHT_COLOR[d.lightB]} stroke="#0008" />
      {d.showPorts && (
        <>
          <text x={lax} y={lay - 6} className="fill-muted text-[9px]" textAnchor="middle">{d.portA.replace('GigabitEthernet', 'Gig').replace('FastEthernet', 'Fa')}</text>
          <text x={lbx} y={lby - 6} className="fill-muted text-[9px]" textAnchor="middle">{d.portB.replace('GigabitEthernet', 'Gig').replace('FastEthernet', 'Fa')}</text>
        </>
      )}
    </>
  );
}

const nodeTypes = { device: DeviceNode, note: NoteNode, zone: ZoneNode };
function WifiEdge({ id, sourceX, sourceY, targetX, targetY }: EdgeProps) {
  return <BaseEdge id={id} path={`M${sourceX},${sourceY} L${targetX},${targetY}`} style={{ stroke: '#38bdf8', strokeWidth: 1.5, strokeDasharray: '2 5', opacity: 0.8 }} />;
}

const edgeTypes = { cable: CableEdge, wifi: WifiEdge };

const PROTO_COLOR: Record<string, string> = { ARP: '#eab308', ICMP: '#a855f7', UDP: '#22d3ee', TCP: '#3b82f6' };

/** Animated envelopes for the frames sent during the last simulation step. */
function PduOverlay({ events, devices, duration }: { events: SimEvent[]; devices: Map<string, DeviceView>; duration: number }) {
  return (
    <ViewportPortal>
      {events.map((e) => {
        const a = devices.get(e.device);
        const b = e.to ? devices.get(e.to) : undefined;
        if (!a || !b) return null;
        const path = `path("M${a.x + NODE_W / 2},${a.y + 26} L${b.x + NODE_W / 2},${b.y + 26}")`;
        return (
          <div
            key={e.seq}
            className="pointer-events-none absolute left-0 top-0 h-3.5 w-5 rounded-sm border border-black/40 shadow"
            style={{ background: PROTO_COLOR[e.proto] ?? '#94a3b8', offsetPath: path, offsetRotate: '0deg', animation: `nl-pdu ${duration}ms linear forwards` }}
          />
        );
      })}
    </ViewportPortal>
  );
}

interface PortPick {
  device: DeviceView;
  x: number;
  y: number;
  onPick(port: string): void;
}

function PortPicker({ pick, onClose }: { pick: PortPick; onClose(): void }) {
  const t = useT();
  const ports = pick.device.ports;
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="nl-scroll absolute max-h-80 w-56 overflow-auto rounded-md border border-line bg-panel py-1 shadow-xl" style={{ left: Math.min(pick.x, innerWidth - 230), top: Math.min(pick.y, innerHeight - 330) }} onClick={(e) => e.stopPropagation()} role="menu">
        <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('cable.pickPort')} — {pick.device.name}</div>
        {ports.map((p: PortView) => (
          <button key={p.name} role="menuitem" disabled={p.linked} onClick={() => pick.onPick(p.name)} className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40">
            <span>{p.name}</span>
            <span className="text-[10px] text-muted">{p.media}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Canvas({ project }: { project: string }) {
  const t = useT();
  const view = useSim((s) => s.views[project]);
  const events = useSim((s) => s.events[project]);
  const { tool, selection, showIps, showPorts, snap, minimap, mode, set, toast } = useUi();
  const rf = useReactFlow();
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({});
  const [pending, setPending] = useState<{ device: string; port?: string } | null>(null);
  const [pick, setPick] = useState<PortPick | null>(null);
  const [ctx, setCtx] = useState<string | null>(null);
  const [lastStepSeq, setLastStepSeq] = useState(0);
  const collab = useCollab((s) => s.sessions[project]);
  const lastCursor = useRef(0);

  const devices = useMemo(() => new Map((view?.devices ?? []).map((d) => [d.id, d])), [view]);

  useEffect(() => setPending(null), [tool]);

  const nodes: Node[] = useMemo(() => {
    if (!view) return [];
    const zones: Node[] = view.zones.map((z) => ({ id: z.id, type: 'zone', position: drag[z.id] ?? { x: z.x, y: z.y }, width: z.w, height: z.h, style: { width: z.w, height: z.h }, zIndex: -1, selected: selection.includes(z.id), data: { id: z.id, label: z.label, color: z.color, project } }));
    const devs: Node[] = view.devices.map((d) => ({ id: d.id, type: 'device', position: drag[d.id] ?? { x: d.x, y: d.y }, selected: selection.includes(d.id), data: { dev: d, showIps } }));
    const notes: Node[] = view.notes.map((n) => ({ id: n.id, type: 'note', position: drag[n.id] ?? { x: n.x, y: n.y }, selected: selection.includes(n.id), data: { id: n.id, text: n.text, color: n.color, project } }));
    return [...zones, ...devs, ...notes];
  }, [view, drag, selection, showIps, project]);

  const edges: Edge[] = useMemo(() => {
    if (!view) return [];
    const pairCount = new Map<string, number>();
    return view.links.map((l) => {
      const key = [l.a.device, l.b.device].sort().join('|');
      const n = pairCount.get(key) ?? 0;
      pairCount.set(key, n + 1);
      const offset = n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 10 * (l.a.device < l.b.device ? 1 : -1);
      return { id: l.id, source: l.a.device, target: l.b.device, type: 'cable', selected: selection.includes(l.id), data: { cable: l.cable, lightA: l.a.light, lightB: l.b.light, portA: l.a.port, portB: l.b.port, showPorts, offset } } as Edge;
    }).concat(view.wireless.map((w) => ({ id: `wifi:${w.client}`, source: w.client, target: w.ap, type: 'wifi', selectable: false, data: {} }) as Edge));
  }, [view, selection, showPorts]);

  const onNodesChange = useCallback(
    (changes: Iterable<NodeChange>) => {
      const moves: Record<string, { x: number; y: number }> = {};
      let sel: string[] | null = null;
      for (const c of changes) {
        if (c.type === 'position' && c.position) moves[c.id] = c.position;
        if (c.type === 'select') {
          sel ??= [...useUi.getState().selection];
          if (c.selected && !sel.includes(c.id)) sel.push(c.id);
          if (!c.selected) sel = sel.filter((x) => x !== c.id);
        }
      }
      if (Object.keys(moves).length) setDrag((p) => ({ ...p, ...moves }));
      if (sel) set({ selection: sel });
    },
    [set],
  );

  const fail = (e: unknown) => {
    const err = e as SimError;
    toast(t(`err.${err.code ?? 'generic'}`) === `err.${err.code}` ? err.message : t(`err.${err.code ?? 'generic'}`), 'error');
  };

  const onNodeClick = (ev: React.MouseEvent, node: Node) => {
    const dev = devices.get(node.id);
    if (!dev) return;
    if (tool.kind === 'pdu') {
      if (!pending) return setPending({ device: dev.id });
      if (pending.device === dev.id) return;
      void sim.simPdu(project, pending.device, dev.id).catch(fail);
      setPending(null);
      return;
    }
    if (tool.kind !== 'cable') return;
    const cable = tool.cable;
    if (cable === 'auto') {
      if (!pending) return setPending({ device: dev.id });
      if (pending.device === dev.id) return;
      void sim.op(project, 'autoLink', pending.device, dev.id).catch(fail);
      setPending(null);
      return;
    }
    setPick({
      device: dev,
      x: ev.clientX,
      y: ev.clientY,
      onPick: (port) => {
        setPick(null);
        if (!pending) return setPending({ device: dev.id, port });
        void sim.op(project, 'addLink', cable, { device: pending.device, port: pending.port }, { device: dev.id, port }).catch(fail);
        setPending(null);
      },
    });
  };

  const onPaneClick = (ev: React.MouseEvent) => {
    const p = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    if (tool.kind === 'note') void sim.op(project, 'addNote', p.x, p.y, 'Note');
    else if (tool.kind === 'zone') void sim.op(project, 'addZone', p.x, p.y, 320, 220, 'Zone');
    else setPending(null);
    if (tool.kind === 'note' || tool.kind === 'zone') set({ tool: { kind: 'select' } });
  };

  const onDrop = (ev: React.DragEvent) => {
    const model = ev.dataTransfer.getData('application/x-netlab-model');
    if (!model) return;
    ev.preventDefault();
    const p = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    const g = snap ? 20 : 1;
    void sim.op<string>(project, 'addDevice', model, Math.round((p.x - NODE_W / 2) / g) * g, Math.round((p.y - NODE_H / 2) / g) * g).then((id) => set({ selection: [id] })).catch(fail);
  };

  // Frames emitted in the most recent simulation step are animated.
  const stepEvents = useMemo(() => {
    if (mode !== 'simulation' || !events?.length) return [];
    const last = events[events.length - 1]!;
    return events.filter((e) => e.kind === 'tx' && e.at === last.at && e.seq > lastStepSeq);
  }, [events, mode, lastStepSeq]);
  useEffect(() => {
    if (mode !== 'simulation') setLastStepSeq(events?.[events.length - 1]?.seq ?? 0);
  }, [mode, events]);

  if (!view) return null;
  const hint = tool.kind === 'cable' ? t('cable.hint') : tool.kind === 'pdu' ? t('sim.pduHint') : null;
  const target = ctx ? devices.get(ctx) : undefined;

  return (
    <CM.Root onOpenChange={(o) => !o && setCtx(null)}>
      <CM.Trigger asChild>
        <div className="relative h-full w-full" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onMouseMove={(e) => {
          if (!collab) return;
          const now = Date.now();
          if (now - lastCursor.current < 120) return;
          lastCursor.current = now;
          const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          sendCursor(project, Math.round(p.x), Math.round(p.y));
        }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={(changes) => {
              let sel = [...useUi.getState().selection];
              for (const c of changes) if (c.type === 'select') sel = c.selected ? [...new Set([...sel, c.id])] : sel.filter((x) => x !== c.id);
              set({ selection: sel });
            }}
            onNodeDragStop={(_, __, dragged) => {
              const moves = dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
              void sim.op(project, 'moveDevices', moves).then(() => setDrag({}));
            }}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={(_, n) => devices.has(n.id) && set({ windowDevice: n.id })}
            onPaneClick={onPaneClick}
            onNodeContextMenu={(_, n) => {
              setCtx(n.id);
              if (!useUi.getState().selection.includes(n.id)) set({ selection: [n.id] });
            }}
            onPaneContextMenu={() => setCtx(null)}
            snapToGrid={snap}
            snapGrid={[20, 20]}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            multiSelectionKeyCode={['Meta', 'Control']}
            minZoom={0.1}
            maxZoom={3}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            className={tool.kind !== 'select' ? 'cursor-crosshair' : ''}
          >
            <Background gap={20} color="var(--nl-grid)" />
            <Controls showInteractive={false} />
            {minimap && <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'device' ? '#3b82f6' : n.type === 'zone' ? 'transparent' : '#facc15')} />}
            <PduOverlay events={stepEvents} devices={devices} duration={600} />
            {collab && (
              <ViewportPortal>
                {Object.entries(collab.cursors).filter(([, c]) => Date.now() - c.at < 10_000).map(([id, c]) => (
                  <div key={id} className="pointer-events-none absolute left-0 top-0 text-[11px] text-accent2" style={{ transform: `translate(${c.x}px, ${c.y}px)` }}>▲ {c.name}</div>
                ))}
              </ViewportPortal>
            )}
          </ReactFlow>
          {hint && (
            <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-accent px-3 py-1 text-[12px] text-white shadow">
              {hint}
              {pending && ` — ${devices.get(pending.device)?.name}${pending.port ? ` ${pending.port}` : ''} → …`}
            </div>
          )}
          {pick && <PortPicker pick={pick} onClose={() => setPick(null)} />}
        </div>
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className="z-50 min-w-48 rounded-md border border-line bg-panel py-1 text-[13px] shadow-xl">
          {target ? (
            <>
              <Item onSelect={() => set({ windowDevice: target.id })}>{t('props.open')}</Item>
              <Item onSelect={() => set({ cliDevice: target.id })}>CLI</Item>
              <Item onSelect={() => void sim.op(project, 'setPower', target.id, !target.powered)}>{t('props.power')}: {target.powered ? t('props.off') : t('props.on')}</Item>
              <Item onSelect={() => void sim.op<string[]>(project, 'duplicate', useUi.getState().selection.filter((s) => devices.has(s)), 40, 40).then((ids) => set({ selection: ids }))}>{t('edit.duplicate')}</Item>
              <CM.Separator className="my-1 h-px bg-line" />
              <Item onSelect={() => void sim.op(project, 'removeItems', useUi.getState().selection).then(() => set({ selection: [] }))}>{t('edit.delete')}</Item>
            </>
          ) : (
            <>
              <Item onSelect={() => set({ tool: { kind: 'note' } })}>{t('tool.note')}</Item>
              <Item onSelect={() => set({ tool: { kind: 'zone' } })}>{t('tool.zone')}</Item>
              <Item onSelect={() => rf.fitView({ padding: 0.2 })}>{t('view.fit')}</Item>
            </>
          )}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect(): void }) {
  return (
    <CM.Item onSelect={onSelect} className="cursor-default px-3 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-white">
      {children}
    </CM.Item>
  );
}
