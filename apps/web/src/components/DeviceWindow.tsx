import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { MODELS, MODULES, type HostConfig, type ServicesDoc, WIFI_RANGE } from '@netlab/engine';
import { Power, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { downloadFile } from '../projects';
import { type SimError, sim, useSim } from '../sim/client';
import type { DeviceView } from '../sim/protocol';
import { useUi } from '../store';
import { DeviceIcon, LIGHT_COLOR } from './icons';
import { Terminal } from './Terminal';

export function useFail() {
  const t = useT();
  const toast = useUi((s) => s.toast);
  return (e: unknown) => {
    const err = e as SimError;
    const k = `err.${err.code ?? 'generic'}`;
    const msg = t(k);
    toast(msg === k ? err.message : msg, 'error');
  };
}

/** Packet Tracer suggests the classful mask for the address typed. */
function classful(ip: string): string {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return '';
  const first = Number(ip.split('.')[0]);
  return first < 128 ? '255.0.0.0' : first < 192 ? '255.255.0.0' : '255.255.255.0';
}

export function HostIpForm({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const fail = useFail();
  const toast = useUi((s) => s.toast);
  const [f, setF] = useState<HostConfig>(dev.host!);
  const h = dev.host!;
  useEffect(() => setF(structuredClone(dev.host!)), [dev.id, h.ip, h.mask, h.gateway, h.dns, h.portUp, h.ipMode, h.ipv6, h.ipv6Gateway, h.ipv6Mode, h.wifi?.ssid, h.wifi?.key]);
  const wireless = dev.ports.some((p) => p.media === 'wireless');
  const input = 'rounded border border-line bg-panel2 px-2 py-1 font-mono outline-none focus:border-accent disabled:opacity-50';
  const field = (k: 'ip' | 'mask' | 'gateway' | 'dns' | 'ipv6' | 'ipv6Gateway', label: string, disabled = false) => (
    <label className="flex flex-col gap-0.5 text-[12px]">
      <span className="text-muted">{label}</span>
      <input className={input} value={f[k] ?? ''} disabled={disabled} onChange={(e) => {
        const v = e.target.value.trim();
        setF((x) => ({ ...x, [k]: v }));
      }} placeholder={k === 'mask' ? classful(f.ip) : ''} />
    </label>
  );
  const dhcp = f.ipMode === 'dhcp';
  const ipv6Mode = f.ipv6Mode ?? 'static';
  const ipv6Auto = ipv6Mode !== 'static';
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const base = { portUp: f.portUp, ipv6: f.ipv6 ?? '', ipv6Gateway: f.ipv6Gateway ?? '', ipv6Mode, ...(wireless ? { wifi: f.wifi ?? { ssid: '', key: '' } } : {}) };
        const cfg = dhcp ? { ...base, ipMode: 'dhcp' as const } : { ...base, ipMode: 'static' as const, ip: f.ip, mask: f.mask || (f.ip ? classful(f.ip) : ''), gateway: f.gateway, dns: f.dns };
        void (async () => {
          await sim.op(project, 'setHostConfig', dev.id, cfg);
          if (dhcp) {
            const r = await sim.op<{ ok: boolean; ip?: string }>(project, 'dhcpRenew', dev.id);
            toast(r.ok ? t('host.dhcpOk', { ip: r.ip ?? '' }) : t('host.dhcpFail'), r.ok ? 'info' : 'error');
          }
          if (ipv6Auto) {
            const r = await sim.op<{ ok: boolean; ipv6?: string }>(project, 'ipv6Renew', dev.id);
            toast(r.ok ? t('host.ipv6Ok', { ip: r.ipv6 ?? '' }) : t('host.ipv6Fail'), r.ok ? 'info' : 'error');
          } else if (!dhcp) toast(t('win.applied'));
        })().catch(fail);
      }}
    >
      <fieldset className="flex gap-4 text-[12px]">
        <legend className="text-muted">{t('host.mode')}</legend>
        {(['static', 'dhcp'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" name={`mode-${dev.id}`} checked={f.ipMode === m} onChange={() => setF({ ...f, ipMode: m })} /> {t(`host.${m}`)}
          </label>
        ))}
      </fieldset>
      {field('ip', t('host.ip'), dhcp)}
      {field('mask', t('host.mask'), dhcp)}
      {field('gateway', t('host.gateway'), dhcp)}
      {field('dns', t('host.dns'), dhcp)}
      <label className="flex flex-col gap-0.5 text-[12px]">
        <span className="text-muted">{t('host.ipv6Mode')}</span>
        <select className={input} value={ipv6Mode} onChange={(e) => setF({ ...f, ipv6Mode: e.target.value as HostConfig['ipv6Mode'], ...(e.target.value === 'static' ? {} : { ipv6: '', ipv6Gateway: '' }) })}>
          <option value="static">{t('host.static')}</option>
          <option value="slaac">SLAAC</option>
          <option value="dhcpv6">DHCPv6</option>
        </select>
      </label>
      {field('ipv6', t('host.ipv6'), ipv6Auto)}
      {field('ipv6Gateway', t('host.ipv6gw'), ipv6Auto)}
      {wireless && (
        <>
          <label className="flex flex-col gap-0.5 text-[12px]"><span className="text-muted">{t('host.ssid')}</span>
            <input className={input} value={f.wifi?.ssid ?? ''} onChange={(e) => setF({ ...f, wifi: { ssid: e.target.value, key: f.wifi?.key ?? '' } })} /></label>
          <label className="flex flex-col gap-0.5 text-[12px]"><span className="text-muted">{t('host.wifikey')}</span>
            <input className={input} type="password" value={f.wifi?.key ?? ''} onChange={(e) => setF({ ...f, wifi: { ssid: f.wifi?.ssid ?? '', key: e.target.value } })} /></label>
        </>
      )}
      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={f.portUp} onChange={(e) => setF({ ...f, portUp: e.target.checked })} />
        {t('host.port')}
      </label>
      <button className="self-start rounded bg-accent px-3 py-1 text-white hover:brightness-110">{dhcp || ipv6Auto ? t('host.renew') : t('win.apply')}</button>
    </form>
  );
}

function ApConfig({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const fail = useFail();
  const toast = useUi((s) => s.toast);
  const [w, setW] = useState(dev.wireless!);
  const input = 'rounded border border-line bg-panel2 px-2 py-1 outline-none focus:border-accent';
  return (
    <form className="flex max-w-sm flex-col gap-2 text-[12px]" onSubmit={(e) => {
      e.preventDefault();
      void sim.op(project, 'setWireless', dev.id, w).then(() => toast(t('win.applied')), fail);
    }}>
      <h3 className="font-semibold">{t('ap.title')}</h3>
      <label className="flex flex-col gap-0.5"><span className="text-muted">{t('ap.ssid')}</span><input className={input} value={w.ssid} onChange={(e) => setW({ ...w, ssid: e.target.value })} /></label>
      <fieldset className="flex gap-4"><legend className="text-muted">{t('ap.security')}</legend>
        <label className="flex items-center gap-1"><input type="radio" checked={w.security === 'open'} onChange={() => setW({ ...w, security: 'open' })} /> {t('ap.open')}</label>
        <label className="flex items-center gap-1"><input type="radio" checked={w.security === 'wpa2'} onChange={() => setW({ ...w, security: 'wpa2' })} /> WPA2-PSK</label>
      </fieldset>
      {w.security === 'wpa2' && <label className="flex flex-col gap-0.5"><span className="text-muted">{t('ap.key')}</span><input className={input} type="password" value={w.key} onChange={(e) => setW({ ...w, key: e.target.value })} /></label>}
      <p className="text-muted">{t('ap.range', { r: WIFI_RANGE })}</p>
      <button className="self-start rounded bg-accent px-3 py-1 text-white">{t('win.apply')}</button>
    </form>
  );
}

function Services({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const fail = useFail();
  const toast = useUi((s) => s.toast);
  const [svc, setSvc] = useState<ServicesDoc>(structuredClone(dev.services!));
  const [page, setPage] = useState(Object.keys(dev.services!.http.pages)[0] ?? '/index.html');
  const [rec, setRec] = useState({ name: '', ip: '' });
  const input = 'rounded border border-line bg-panel2 px-2 py-1 font-mono outline-none focus:border-accent';
  const up = (fn: (s: ServicesDoc) => void) => setSvc((x) => { const y = structuredClone(x); fn(y); return y; });
  const section = 'rounded border border-line p-3';
  const enabled = (k: 'dhcp' | 'dns' | 'http' | 'tftp' | 'ftp' | 'mail' | 'ntp') => (
    <label className="flex items-center gap-1"><input type="checkbox" checked={svc[k].enabled} onChange={(e) => up((s) => (s[k].enabled = e.target.checked))} /> {t('svc.enabled')}</label>
  );
  const pool = svc.dhcp.pools[0]!;
  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <section className={section}>
        <div className="mb-2 flex justify-between"><h3 className="font-semibold">{t('svc.dhcp')}</h3>{enabled('dhcp')}</div>
        <div className="grid grid-cols-3 gap-2">
          {([['gateway', 'host.gateway'], ['dns', 'host.dns'], ['start', 'svc.start'], ['mask', 'host.mask']] as const).map(([k, l]) => (
            <label key={k} className="flex flex-col gap-0.5"><span className="text-muted">{t(l)}</span><input className={input} value={pool[k]} onChange={(e) => up((s) => (s.dhcp.pools[0]![k] = e.target.value.trim()))} /></label>
          ))}
          <label className="flex flex-col gap-0.5"><span className="text-muted">{t('svc.max')}</span><input className={input} type="number" min={1} max={4096} value={pool.max} onChange={(e) => up((s) => (s.dhcp.pools[0]!.max = Number(e.target.value) || 1))} /></label>
        </div>
      </section>
      <section className={section}>
        <div className="mb-2 flex justify-between"><h3 className="font-semibold">{t('svc.dns')}</h3>{enabled('dns')}</div>
        <div className="mb-2 flex gap-2">
          <input aria-label={t('svc.name')} placeholder="www.exemple.lan" className={input} value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} />
          <input aria-label={t('svc.address')} placeholder="192.168.1.10" className={input} value={rec.ip} onChange={(e) => setRec({ ...rec, ip: e.target.value })} />
          <button type="button" className="rounded border border-line px-2" onClick={() => { if (rec.name && rec.ip) { up((s) => s.dns.records.push({ name: rec.name.toLowerCase(), ip: rec.ip })); setRec({ name: '', ip: '' }); } }}>{t('svc.add')}</button>
        </div>
        <ul>{svc.dns.records.map((r, i) => (
          <li key={`${r.name}${i}`} className="flex justify-between font-mono"><span>{r.name} A {r.ip}</span><button type="button" className="text-bad" onClick={() => up((s) => s.dns.records.splice(i, 1))}>{t('win.remove')}</button></li>
        ))}</ul>
      </section>
      <section className={section}>
        <div className="mb-2 flex justify-between"><h3 className="font-semibold">{t('svc.http')}</h3>
          <div className="flex gap-3">{enabled('http')}<label className="flex items-center gap-1"><input type="checkbox" checked={svc.http.https} onChange={(e) => up((s) => (s.http.https = e.target.checked))} /> HTTPS</label></div></div>
        <div className="mb-1 flex gap-2">
          <select aria-label={t('svc.page')} className={input} value={page} onChange={(e) => setPage(e.target.value)}>
            {Object.keys(svc.http.pages).map((p) => <option key={p}>{p}</option>)}
          </select>
          <button type="button" className="rounded border border-line px-2" onClick={() => { const n = prompt(t('svc.page'), '/page.html'); if (n && n.startsWith('/')) { up((s) => (s.http.pages[n] = '<html><body></body></html>')); setPage(n); } }}>{t('svc.add')}</button>
        </div>
        <textarea aria-label={t('svc.content')} className={`${input} h-28 w-full`} value={svc.http.pages[page] ?? ''} onChange={(e) => up((s) => (s.http.pages[page] = e.target.value))} />
      </section>
      <section className={section}>
        <div className="mb-2 flex justify-between"><h3 className="font-semibold">{t('svc.tftp')}</h3>{enabled('tftp')}</div>
        <p className="text-muted">{t('svc.files')}</p>
        {Object.keys(dev.services!.tftp.files).length === 0 ? <p className="text-muted">{t('svc.none')}</p> : (
          <ul>{Object.entries(dev.services!.tftp.files).map(([n, c]) => (
            <li key={n} className="flex justify-between font-mono"><span>{n} ({c.length} o)</span><button type="button" className="text-accent" onClick={() => downloadFile(n, c, 'text/plain')}>↓</button></li>
          ))}</ul>
        )}
      </section>
      <section className={section}>
        <h3 className="mb-2 font-semibold">{t('svc.ftp')}</h3>{enabled('ftp')}
        <p className="text-muted">{t('svc.ftpHelp')}</p>
        <p className="font-mono">{Object.keys(dev.services!.ftp.files).sort().join(', ') || t('svc.none')}</p>
      </section>
      <section className={section}>
        <h3 className="mb-2 font-semibold">{t('svc.mail')}</h3>{enabled('mail')}
        <p className="text-muted">{t('svc.mailHelp')}</p>
      </section>
      <section className={section}>
        <h3 className="mb-2 font-semibold">{t('svc.ntp')}</h3>{enabled('ntp')}
        <p className="text-muted">{t('svc.ntpHelp')}</p>
      </section>
      <button className="self-start rounded bg-accent px-3 py-1 text-white" onClick={() => void sim.op(project, 'setServices', dev.id, { ...svc, tftp: { ...svc.tftp, files: dev.services!.tftp.files }, ftp: { ...svc.ftp, files: dev.services!.ftp.files }, mail: { ...svc.mail, messages: dev.services!.mail.messages } }).then(() => toast(t('win.applied')), fail)}>{t('svc.save')}</button>
    </div>
  );
}

function Browser({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const [url, setUrl] = useState('http://');
  const [res, setRes] = useState<{ status: number; body: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex h-[400px] flex-col gap-2">
      <form className="flex gap-2" onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void sim.browse(project, dev.id, url).then(setRes).finally(() => setBusy(false));
      }}>
        <input aria-label="URL" className="flex-1 rounded border border-line bg-panel2 px-2 py-1 font-mono" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="rounded bg-accent px-3 text-white" disabled={busy}>{t('desk.go')}</button>
      </form>
      <div className="flex-1 overflow-hidden rounded border border-line bg-white">
        {res && 'error' in res && <p className="p-4 text-slate-700">{res.error}</p>}
        {/* The page comes from a simulated server: rendered in a fully sandboxed frame (no scripts, no same-origin). */}
        {res && 'body' in res && <iframe title="page" sandbox="" srcDoc={res.body} className="h-full w-full" />}
      </div>
    </div>
  );
}

function Physical({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const fail = useFail();
  const spec = MODELS[dev.model]!;
  return (
    <div className="flex gap-6">
      <div className="flex flex-col items-center gap-3">
        <DeviceIcon kind={dev.kind} role={dev.role} size={96} off={!dev.powered} />
        <button onClick={() => void sim.op(project, 'setPower', dev.id, !dev.powered).catch(fail)} className={`flex items-center gap-2 rounded px-3 py-1.5 text-white ${dev.powered ? 'bg-ok' : 'bg-slate-600'}`} aria-pressed={dev.powered}>
          <Power size={14} /> {dev.powered ? t('props.on') : t('props.off')}
        </button>
      </div>
      <div className="flex-1">
        {spec.bays.length > 0 && (
          <>
            <h3 className="mb-1 font-semibold">{t('win.modules')}</h3>
            {dev.powered && <p className="mb-2 text-[12px] text-warn">{t('win.powerOffFirst')}</p>}
            <table className="w-full text-[12px]">
              <tbody>
                {spec.bays.map((b) => {
                  const cur = dev.modules[b.id];
                  return (
                    <tr key={b.id} className="border-b border-line">
                      <td className="py-1 pr-2 text-muted">{b.label}</td>
                      <td className="py-1">{cur ? `${cur} — ${MODULES[cur]!.description}` : t('win.empty')}</td>
                      <td className="py-1 text-right">
                        {cur ? (
                          <button disabled={dev.powered} onClick={() => void sim.op(project, 'setModule', dev.id, b.id, null).catch(fail)} className="rounded border border-line px-2 py-0.5 disabled:opacity-40">{t('win.remove')}</button>
                        ) : (
                          b.accepts.map((m) => (
                            <button key={m} disabled={dev.powered} onClick={() => void sim.op(project, 'setModule', dev.id, b.id, m).catch(fail)} className="ml-1 rounded border border-line px-2 py-0.5 disabled:opacity-40" title={MODULES[m]!.description}>
                              {t('win.install')} {m}
                            </button>
                          ))
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        <h3 className="mb-1 mt-3 font-semibold">{t('props.interfaces')}</h3>
        <ul className="grid grid-cols-2 gap-x-4 text-[12px]">
          {dev.ports.map((p) => (
            <li key={p.name} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: LIGHT_COLOR[p.light] }} aria-hidden />
              {p.name} <span className="text-muted">{p.media}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function IosConfigTab({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const fail = useFail();
  const toast = useUi((s) => s.toast);
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted">
        {t('props.hostname')}: <b className="text-fg">{dev.hostname}</b> · {dev.modified ? t('props.unsaved') : 'running = startup'}
      </p>
      <div className="flex gap-2">
        <button className="rounded border border-line px-2 py-1" onClick={() => void sim.runningConfig(project, dev.id).then((c) => downloadFile(`${dev.hostname}-running-config.txt`, c, 'text/plain'))}>
          {t('win.exportConfig')}
        </button>
      </div>
      <label className="text-[12px] text-muted" htmlFor="imp">{t('win.importConfig')}</label>
      <textarea id="imp" className="h-48 rounded border border-line bg-panel2 p-2 font-mono text-[12px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={'hostname R1\ninterface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown'} />
      <button
        className="self-start rounded bg-accent px-3 py-1 text-white"
        onClick={() =>
          void sim.op<string[]>(project, 'importConfig', dev.id, text).then((errs) => {
            if (errs.length) toast(errs.slice(0, 3).join('\n'), 'error');
            else toast(t('win.applied'));
          }, fail)
        }
      >
        {t('win.apply')}
      </button>
    </div>
  );
}

function Desktop({ project, dev }: { project: string; dev: DeviceView }) {
  const t = useT();
  const [app, setApp] = useState<'ip' | 'prompt' | 'terminal' | 'browser' | null>(null);
  const view = useSim((s) => s.views[project]);
  const consoleLink = view?.links.find((l) => (l.a.device === dev.id && l.a.port === 'RS 232') || (l.b.device === dev.id && l.b.port === 'RS 232'));
  const consoleTarget = consoleLink ? (consoleLink.a.device === dev.id ? consoleLink.b.device : consoleLink.a.device) : null;
  const apps = [
    { id: 'ip' as const, label: t('desk.ipconfig') },
    { id: 'prompt' as const, label: t('desk.prompt') },
    { id: 'browser' as const, label: t('desk.browser') },
    ...(dev.ports.some((p) => p.name === 'RS 232') ? [{ id: 'terminal' as const, label: t('desk.terminal') }] : []),
  ];
  if (!app)
    return (
      <div className="grid grid-cols-3 gap-3">
        {apps.map((a) => (
          <button key={a.id} onClick={() => setApp(a.id)} className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg border border-line bg-panel2 hover:border-accent">
            <span className="text-2xl" aria-hidden>{a.id === 'ip' ? '⚙' : a.id === 'prompt' ? '⌨' : a.id === 'browser' ? '🌐' : '🖥'}</span>
            {a.label}
          </button>
        ))}
      </div>
    );
  return (
    <div className="flex h-full flex-col gap-2">
      <button className="self-start text-[12px] text-accent" onClick={() => setApp(null)}>← {t('win.desktop')}</button>
      {app === 'ip' && <HostIpForm project={project} dev={dev} />}
      {app === 'browser' && <Browser project={project} dev={dev} />}
      {app === 'prompt' && <div className="h-[380px]"><Terminal project={project} device={dev.id} kind="host" session={`host:${dev.id}`} autoFocus /></div>}
      {app === 'terminal' && (consoleTarget ? <div className="h-[380px]"><Terminal project={project} device={consoleTarget} kind="ios" session={`console:${consoleTarget}`} autoFocus /></div> : <p className="text-muted">{t('desk.noConsole')}</p>)}
    </div>
  );
}

export function DeviceWindow({ project }: { project: string }) {
  const t = useT();
  const { windowDevice, set } = useUi();
  const dev = useSim((s) => s.views[project]?.devices.find((d) => d.id === windowDevice));
  if (!dev) return null;
  const ios = dev.kind === 'router' || dev.kind === 'switch' || dev.kind === 'l3switch';
  const tabs = [
    { id: 'physical', label: t('win.physical') },
    ...(dev.kind !== 'hub' ? [{ id: 'config', label: t('win.config') }] : []),
    ...(ios ? [{ id: 'cli', label: t('win.cli') }] : []),
    ...(dev.services ? [{ id: 'services', label: t('win.services') }] : []),
    ...(dev.kind === 'host' ? [{ id: 'desktop', label: t('win.desktop') }] : []),
  ];
  return (
    <Dialog.Root open onOpenChange={(o) => !o && set({ windowDevice: null })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[560px] max-h-[95vh] w-[760px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <Dialog.Title className="font-semibold">{dev.name} <span className="text-muted">— {MODELS[dev.model]!.label}</span></Dialog.Title>
            <Dialog.Close aria-label="close" className="rounded p-1 hover:bg-panel2"><X size={16} /></Dialog.Close>
          </div>
          <Tabs.Root defaultValue={ios ? 'cli' : dev.kind === 'host' ? 'desktop' : 'physical'} className="flex min-h-0 flex-1 flex-col">
            <Tabs.List className="flex gap-1 border-b border-line px-3">
              {tabs.map((x) => (
                <Tabs.Trigger key={x.id} value={x.id} className="border-b-2 border-transparent px-3 py-1.5 data-[state=active]:border-accent data-[state=active]:text-accent">{x.label}</Tabs.Trigger>
              ))}
            </Tabs.List>
            <div className="nl-scroll min-h-0 flex-1 overflow-auto p-4">
              <Tabs.Content value="physical"><Physical project={project} dev={dev} /></Tabs.Content>
              <Tabs.Content value="config">{dev.kind === 'host' ? <HostIpForm project={project} dev={dev} /> : dev.kind === 'ap' || dev.role === 'wireless-router' ? <ApConfig project={project} dev={dev} /> : <IosConfigTab project={project} dev={dev} />}</Tabs.Content>
              {dev.services && <Tabs.Content value="services"><Services project={project} dev={dev} /></Tabs.Content>}
              {ios && <Tabs.Content value="cli" className="h-full"><div className="h-[420px]"><Terminal project={project} device={dev.id} kind="ios" session={`console:${dev.id}`} autoFocus /></div></Tabs.Content>}
              {dev.kind === 'host' && <Tabs.Content value="desktop" className="h-full"><Desktop project={project} dev={dev} /></Tabs.Content>}
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
