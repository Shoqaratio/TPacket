import * as Dialog from '@radix-ui/react-dialog';
import { ICMP_TYPES, ip6ToString, ipToString, macCisco, type SimEvent } from '@netlab/engine';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useSim } from '../sim/client';
import { useUi } from '../store';
import { Terminal } from './Terminal';
import { TutorPanel } from './TutorPanel';
import { CollabPanel } from './CollabPanel';
import { downloadFile } from '../projects';
import { encodePcap } from '../sim/pcap';

const PROTOS = ['ARP', 'ICMP', 'ICMPv6', 'UDP', 'TCP', 'NDP'];

function Inspector({ ev, names, onClose }: { ev: SimEvent; names: Map<string, string>; onClose(): void }) {
  const t = useT();
  const f = ev.frame;
  const p = f.ip;
  const p6 = f.ip6;
  const reason = ev.reason ? t(`reason.${ev.reason.code}`, ev.reason.params) : null;
  const Row = ({ k, v }: { k: string; v: string | number | undefined }) => (v === undefined ? null : (
    <div className="grid grid-cols-[150px_1fr] gap-2"><span className="text-muted">{k}</span><span className="font-mono">{v}</span></div>
  ));
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-4 text-[12px] shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="text-[14px] font-semibold">{t('pdu.title')} — {names.get(ev.device) ?? ev.device}</Dialog.Title>
            <Dialog.Close className="rounded p-1 hover:bg-panel2" aria-label="close"><X size={16} /></Dialog.Close>
          </div>
          <p className="mb-3 text-muted">{(ev.at / 1000).toFixed(3)} s · {ev.info}</p>
          <h3 className="mb-1 font-semibold">{t('pdu.osi')}</h3>
          <div className="flex flex-col gap-3">
            <section className="rounded border border-line p-2">
              <h4 className="mb-1 font-semibold text-accent">{t('pdu.l1')}</h4>
              <Row k={t('ev.device')} v={names.get(ev.device)} />
              <Row k="Port" v={ev.port} />
              {ev.to && <Row k="→" v={names.get(ev.to)} />}
            </section>
            <section className="rounded border border-line p-2">
              <h4 className="mb-1 font-semibold text-accent">{t('pdu.l2')}</h4>
              {f.hdlc ? <Row k="Encapsulation" v="HDLC" /> : (<>
                <Row k="Ethernet II src" v={f.src ? macCisco(f.src) : undefined} />
                <Row k="Ethernet II dst" v={f.dst ? macCisco(f.dst) : undefined} />
                <Row k="802.1Q VLAN" v={f.tag} />
                <Row k="EtherType" v={f.type === 'arp' ? '0x0806 (ARP)' : f.type === 'ipv6' ? '0x86dd (IPv6)' : '0x0800 (IPv4)'} />
              </>)}
            </section>
            {f.arp && (
              <section className="rounded border border-line p-2">
                <h4 className="mb-1 font-semibold text-accent">ARP</h4>
                <Row k="Opcode" v={f.arp.op === 1 ? '1 (request)' : '2 (reply)'} />
                <Row k="Sender MAC / IP" v={`${macCisco(f.arp.sha)} / ${ipToString(f.arp.spa)}`} />
                <Row k="Target MAC / IP" v={`${macCisco(f.arp.tha)} / ${ipToString(f.arp.tpa)}`} />
              </section>
            )}
            {p && (
              <section className="rounded border border-line p-2">
                <h4 className="mb-1 font-semibold text-accent">{t('pdu.l3')}</h4>
                <Row k="Source IP" v={ipToString(p.src)} />
                <Row k="Destination IP" v={ipToString(p.dst)} />
                <Row k="TTL" v={p.ttl} />
                <Row k="Protocol" v={p.proto.toUpperCase()} />
                <Row k="ID" v={p.id} />
              </section>
            )}
            {p6 && (
              <section className="rounded border border-line p-2">
                <h4 className="mb-1 font-semibold text-accent">{t('pdu.l3')}</h4>
                <Row k="Source IPv6" v={ip6ToString(p6.src)} />
                <Row k="Destination IPv6" v={ip6ToString(p6.dst)} />
                <Row k="Hop limit" v={p6.hop} />
                <Row k="Protocol" v="ICMPv6" />
                {p6.icmp6 && <Row k="ICMPv6 type / code" v={`${p6.icmp6.type} / ${p6.icmp6.code}`} />}
              </section>
            )}
            {p?.icmp && (
              <section className="rounded border border-line p-2">
                <h4 className="mb-1 font-semibold text-accent">{t('pdu.l4')}</h4>
                <Row k="ICMP type / code" v={`${p.icmp.type} (${ICMP_TYPES[p.icmp.type] ?? '?'}) / ${p.icmp.code}`} />
                {p.icmp.type === 8 || p.icmp.type === 0 ? <Row k="Identifier / seq" v={`${p.icmp.ident} / ${p.icmp.seq}`} /> : null}
              </section>
            )}
            {p?.udp && (
              <section className="rounded border border-line p-2">
                <h4 className="mb-1 font-semibold text-accent">{t('pdu.l4')}</h4>
                <Row k="UDP ports" v={`${p.udp.sport} → ${p.udp.dport}`} />
              </section>
            )}
            {p?.tcp && (
              <section className="rounded border border-line p-2">
                <h4 className="mb-1 font-semibold text-accent">{t('pdu.l4')}</h4>
                <Row k="TCP ports" v={`${p.tcp.sport} → ${p.tcp.dport}`} />
                <Row k="Flags" v={p.tcp.flags} />
              </section>
            )}
            {reason && (
              <section className="rounded border border-bad/50 bg-bad/10 p-2 text-bad">
                <h4 className="mb-1 font-semibold">{t('pdu.reason')}</h4>
                {reason}
              </section>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Events({ project }: { project: string }) {
  const t = useT();
  const events = useSim((s) => s.events[project]) ?? [];
  const pdus = useSim((s) => s.pdus[project]) ?? [];
  const view = useSim((s) => s.views[project]);
  const [filter, setFilter] = useState<Record<string, boolean>>({ ARP: true, ICMP: true, ICMPv6: true, UDP: true, TCP: true, NDP: true });
  const [inspect, setInspect] = useState<SimEvent | null>(null);
  const names = useMemo(() => new Map((view?.devices ?? []).map((d) => [d.id, d.name])), [view]);
  const rows = events.filter((e) => filter[e.proto] ?? true).slice(-400).reverse();
  return (
    <div className="flex h-full min-h-0">
      <div className="nl-scroll min-w-0 flex-1 overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-panel2 text-left text-muted">
            <tr><th className="px-2 py-1">{t('ev.time')}</th><th className="px-2">{t('ev.device')}</th><th className="px-2">{t('ev.type')}</th><th className="px-2">{t('ev.result')}</th><th className="px-2">{t('ev.info')}</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-muted">{t('sim.noEvents')}</td></tr>}
            {rows.map((e) => (
              <tr key={e.seq} className="cursor-pointer border-b border-line/50 hover:bg-accent/10" onClick={() => setInspect(e)}>
                <td className="px-2 py-0.5 font-mono">{(e.at / 1000).toFixed(3)}</td>
                <td className="px-2">{names.get(e.device) ?? '—'}{e.to ? ` → ${names.get(e.to) ?? ''}` : ''}</td>
                <td className="px-2 font-semibold">{e.proto}</td>
                <td className={`px-2 ${e.kind === 'drop' ? 'text-bad' : e.kind === 'deliver' ? 'text-ok' : ''}`}>{t(`ev.${e.kind}`)}</td>
                <td className="truncate px-2">{e.reason ? t(`reason.${e.reason.code}`, e.reason.params) : e.info}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="nl-scroll w-56 shrink-0 overflow-auto border-l border-line p-2 text-[12px]">
        <div className="mb-1 font-semibold text-muted">{t('sim.filters')}</div>
        <button
          className="mb-2 w-full rounded border border-line px-2 py-1 text-left hover:bg-accent/10 disabled:opacity-40"
          disabled={!events.some((e) => e.kind === 'tx' && !e.frame.hdlc)}
          onClick={() => downloadFile(`${project}-capture.pcap`, encodePcap(events), 'application/vnd.tcpdump.pcap')}
        >
          {t('sim.exportPcap')}
        </button>
        {PROTOS.map((p) => (
          <label key={p} className="flex items-center gap-2">
            <input type="checkbox" checked={filter[p]} onChange={(e) => setFilter({ ...filter, [p]: e.target.checked })} /> {p}
          </label>
        ))}
        {pdus.length > 0 && (
          <>
            <div className="mb-1 mt-3 font-semibold text-muted">{t('sim.pdus')}</div>
            {pdus.map((p) => (
              <div key={p.id} className="flex justify-between">
                <span>{p.protocol.toUpperCase()} {p.src} → {p.dst}{p.dstPort ? ` :${p.dstPort}` : ''}</span>
                <span className={p.status === 'successful' ? 'text-ok' : p.status === 'failed' ? 'text-bad' : 'text-warn'}>{t(`sim.status.${p.status}`)}</span>
              </div>
            ))}
          </>
        )}
      </div>
      {inspect && <Inspector ev={inspect} names={names} onClose={() => setInspect(null)} />}
    </div>
  );
}

export function BottomPanel({ project }: { project: string }) {
  const t = useT();
  const { cliDevice, bottomHeight, mode, set } = useUi();
  const [tab, setTab] = useState<'cli' | 'events' | 'tutor' | 'collab'>('cli');
  const dev = useSim((s) => s.views[project]?.devices.find((d) => d.id === cliDevice));
  const active = mode === 'simulation' && tab === 'cli' && !dev ? 'events' : tab;
  return (
    <section className="flex shrink-0 flex-col border-t border-line bg-panel" style={{ height: bottomHeight }}>
      <div
        className="h-1 cursor-row-resize hover:bg-accent"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(e) => {
          const startY = e.clientY;
          const start = bottomHeight;
          const move = (ev: PointerEvent) => set({ bottomHeight: Math.max(120, Math.min(innerHeight - 260, start + startY - ev.clientY)) });
          const up = () => {
            removeEventListener('pointermove', move);
            removeEventListener('pointerup', up);
          };
          addEventListener('pointermove', move);
          addEventListener('pointerup', up);
        }}
      />
      <div className="flex items-center gap-1 border-b border-line px-2 text-[12px]" role="tablist">
        {(['cli', 'events', 'tutor', 'collab'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={active === k} onClick={() => setTab(k)} className={`border-b-2 px-3 py-1 ${active === k ? 'border-accent text-accent' : 'border-transparent'}`}>
            {t(`bottom.${k}`)}{k === 'cli' && dev ? ` — ${dev.name}` : ''}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {active === 'cli' ? (
          dev && dev.kind !== 'hub' ? (
            <Terminal key={dev.id} project={project} device={dev.id} kind={dev.kind === 'host' ? 'host' : 'ios'} session={dev.kind === 'host' ? `host:${dev.id}` : `console:${dev.id}`} />
          ) : (
            <p className="p-3 text-[12px] text-muted">{t('bottom.noDevice')}</p>
          )
        ) : active === 'events' ? (
          <Events project={project} />
        ) : active === 'tutor' ? (
          <TutorPanel project={project} />
        ) : (
          <CollabPanel project={project} />
        )}
      </div>
    </section>
  );
}
