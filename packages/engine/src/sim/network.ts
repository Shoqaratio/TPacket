import { copperPinoutOk } from '../model/cables';
import { devicePorts, isIosKind, type ModelSpec, modelSpec } from '../model/catalog';
import * as P from '../model/project';
import type { CableType, DeviceDoc, HostConfig, LinkDoc, PortSpec, ProjectDoc } from '../model/types';
import { BROADCAST_IP, broadcastOf, ipToString, isUsableHost, maskToPrefix, networkOf, parseIp, prefixToMask, wildcardMatch } from '../net/ipv4';
import { ip6ToString, isLinkLocal, linkLocal, network6, parseCidr6, parseIp6 } from '../net/ipv6';
import { BROADCAST_MAC, macAdd, macCisco } from '../net/mac';
import { type AclEntry, defaultIosConfig, type IfConfig, type IosConfig, renderRunningConfig } from '../ios/config';
import { loadIosConfig } from '../ios/load';
import { Apps } from './apps';
import { type NatEntry, natInbound, natOutbound } from './nat';
import { type AppData, cloneFrame, describeFrame, type Dhcp6Msg, type DhcpMsg, type Frame, type IcmpPkt, type Ipv4Pkt, type Ipv6Pkt, type IpQuote, type Ospf6ControlMessage, protoOf, type TcpFlags } from './packets';
import { computeDynamic, type DynamicResult } from './routing';
import { computeStp, portCost, type StpBridge, type StpRole } from './stp';

export const FORWARD_DELAY = 15000;
export const MAC_AGING = 300_000;
const ARP_AGING_IOS = 4 * 3600_000;
const ARP_AGING_HOST = 120_000;
const L2_HOP_LIMIT = 64;
const EVENT_BUDGET = 200_000;
const ALL_ROUTERS6 = (0xff02n << 112n) | 0x2n;
const DHCP_SERVERS6 = (0xff02n << 112n) | 0x10002n;
/** Radio range of an access point, in canvas units. */
export const WIFI_RANGE = 400;

export interface Reason {
  code: string;
  params?: Record<string, string>;
}

export interface SimEvent {
  seq: number;
  at: number;
  device: string;
  kind: 'tx' | 'drop' | 'deliver';
  proto: string;
  info: string;
  port?: string;
  link?: string;
  to?: string;
  arrive?: number;
  reason?: Reason;
  frame: Frame;
}

export interface PortStatus {
  adminDown: boolean;
  l1: boolean;
  proto: boolean;
}

export type LinkLight = 'green' | 'amber' | 'red' | 'off';

export interface ArpEntry {
  mac: string;
  iface: string;
  at: number;
}

export interface MacEntry {
  port: string;
  at: number;
  vlan: number;
  mac: string;
}

export interface Route {
  type: 'C' | 'L' | 'S' | 'R' | 'O';
  /** OSPF external (E2) route, e.g. an originated default. */
  external?: boolean;
  network: number;
  mask: number;
  ad: number;
  metric: number;
  nextHop?: number;
  iface?: string;
  /** Static route has a default-route candidate star in `show ip route`. */
  candidateDefault?: boolean;
}

export interface L3If {
  name: string;
  ip: number;
  mask: number;
  mac: string;
}

export type EchoOutcome =
  | { kind: 'reply'; from: number; rtt: number; ttl: number }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; from: number; code: number }
  | { kind: 'ttl-exceeded'; from: number; rtt: number }
  | { kind: 'port-unreachable'; from: number; rtt: number }
  | { kind: 'no-route' }
  | { kind: 'data'; from: number; rtt: number; data: AppData }
  | { kind: 'synack'; from: number; rtt: number }
  | { kind: 'closed' }
  | { kind: 'reset'; from: number; rtt: number };

export interface L3If6 {
  name: string;
  mac: string;
  ll: bigint;
  addrs: { ip: bigint; len: number }[];
}

export interface Route6 {
  type: 'C' | 'L' | 'S' | 'O';
  prefix: bigint;
  len: number;
  ad: number;
  metric?: number;
  nextHop?: bigint;
  iface?: string;
}

export interface RtPort {
  spec: PortSpec;
  mac: string;
  index: number;
}

export class RtDevice {
  spec: ModelSpec;
  ports = new Map<string, RtPort>();
  portOrder: string[] = [];
  ios?: IosConfig;
  arp = new Map<number, ArpEntry>();
  macTable = new Map<string, MacEntry>();
  pendingArp = new Map<number, { since: number; packets: { iface: string; pkt: Ipv4Pkt }[] }>();
  bootAt = 0;
  clockOffset = 0;
  /** Host flag set when another station answers for our address. */
  ipConflict?: string;
  /** Lines that failed when the stored configuration was replayed (shown in the CLI on boot). */
  loadErrors: string[] = [];
  /** DHCP server bindings (IOS pools and Server device): ip -> client MAC. */
  dhcpBindings = new Map<number, { mac: string; at: number }>();
  /** Host: address of the DHCP server that granted the current lease. */
  dhcpServer?: number;
  natTable: NatEntry[] = [];
  /** IPv6 neighbor cache. */
  nd = new Map<bigint, { mac: string; iface: string; at: number }>();
  dhcp6Bindings = new Map<bigint, { mac: string; at: number }>();
  pendingNd = new Map<bigint, { since: number; packets: { iface: string; pkt: Ipv6Pkt }[] }>();

  constructor(public doc: DeviceDoc) {
    this.spec = modelSpec(doc.model);
    this.buildPorts();
  }

  buildPorts(): void {
    this.ports.clear();
    this.portOrder = [];
    devicePorts(this.doc.model, this.doc.modules).forEach((spec, index) => {
      this.ports.set(spec.name, { spec, index, mac: macAdd(this.doc.macBase, index) });
      this.portOrder.push(spec.name);
    });
  }

  get kind() {
    return this.spec.kind;
  }

  get host(): HostConfig | undefined {
    return this.doc.host;
  }

  get isIos(): boolean {
    return isIosKind(this.spec.kind);
  }

  dataPorts(): string[] {
    return this.portOrder.filter((n) => {
      const m = this.ports.get(n)!.spec.media;
      return m !== 'console' && m !== 'rs232';
    });
  }

  sviMac(): string {
    return macAdd(this.doc.macBase, 63);
  }

  hostname(): string {
    return this.ios?.hostname ?? this.doc.name;
  }
}

function dropReason(code: string, params?: Record<string, string>): Reason {
  return params ? { code, params } : { code };
}

type QueueItem =
  | {
    kind: 'frame';
    at: number;
    seq: number;
    device: string;
    port: string;
    frame: Frame;
  }
  | {
    kind: 'timer';
    at: number;
    seq: number;
    callback: () => void;
  };

export class Network {
  devices = new Map<string, RtDevice>();
  now = 0;
  log: SimEvent[] = [];
  logLimit = 2000;
  onEvent?: (e: SimEvent) => void;
  onConsole?: (device: string, text: string) => void;
  /** Bumped by refresh(); invalidates route caches. */
  version = 0;

  private queue: QueueItem[] = [];
  private seq = 0;
  private evSeq = 0;
  private ipId = 1;
  private ident = 1;
  private sport = 49152;
  private status = new Map<string, PortStatus>();
  private prevIfState = new Map<string, string>();
  private operTrunk = new Map<string, boolean>();
  private stpRoles = new Map<number, Map<string, StpRole>>();
  private stpSince = new Map<string, number>();
  private stpRoot = new Map<number, Map<string, { root: string; cost: number; rootPort?: string; bridges: StpBridge[] }>>();
  private routeCache = new Map<string, { version: number; routes: Route[] }>();
  private waiters = new Map<string, (o: EchoOutcome) => void>();
  private budget = EVENT_BUDGET;
  private apps = new Apps(this);
  private dyn: { version: number; res: DynamicResult } | null = null;
  private initializing = true;

  constructor(public doc: ProjectDoc) {
    for (const d of doc.devices) this.devices.set(d.id, this.bootDevice(d));
    this.refresh();
    this.initializing = false;
  }

  // ===========================================================================================
  // Device lifecycle
  // ===========================================================================================

  private bootDevice(d: DeviceDoc): RtDevice {
    const rt = new RtDevice(d);
    rt.bootAt = this.now;
    if (rt.isIos) {
      rt.ios = defaultIosConfig(rt.spec, rt.dataPorts());
      rt.loadErrors = loadIosConfig(this, rt, d.running ?? '');
    }
    return rt;
  }

  dev(id: string): RtDevice {
    const d = this.devices.get(id);
    if (!d) throw new P.ModelError('not_found', `No device ${id}`);
    return d;
  }

  /** Writes runtime IOS configuration back to the documents and returns the project. */
  serialize(): ProjectDoc {
    for (const d of this.devices.values()) if (d.ios) d.doc.running = this.runningConfig(d);
    return this.doc;
  }

  runningConfig(d: RtDevice): string {
    return renderRunningConfig(d.ios!, d.spec, d.dataPorts());
  }

  /** Power-cycle / `reload`: running-config is lost and the startup-config is loaded, tables are flushed. */
  reload(id: string): void {
    const d = this.dev(id);
    d.doc.running = d.doc.startup ?? '';
    const rt = this.bootDevice(d.doc);
    this.devices.set(id, rt);
    this.clearPrevState(id);
    this.refresh();
    if (rt.isIos && d.doc.powered) {
      this.console(id, `\nSystem Bootstrap, Version ${rt.spec.ios?.version ?? ''}\nCisco IOS Software, ${rt.spec.label} Software (${rt.spec.ios?.image ?? ''})\n${d.doc.startup ? '' : '\n         --- System Configuration Dialog ---\n\nContinue with configuration dialog? [yes/no]: no\n'}\nPress RETURN to get started!\n`);
      for (const e of rt.loadErrors) this.console(id, e);
    }
  }

  setPower(id: string, on: boolean): void {
    const d = this.dev(id);
    if (d.doc.powered === on) return;
    if (!on && d.ios) d.doc.running = this.runningConfig(d);
    d.doc.powered = on;
    if (on) this.reload(id);
    else {
      d.arp.clear();
      d.macTable.clear();
      d.pendingArp.clear();
      this.refresh();
    }
  }

  private clearPrevState(id: string) {
    for (const k of [...this.prevIfState.keys()]) if (k.startsWith(`${id}|`)) this.prevIfState.delete(k);
  }

  // ===========================================================================================
  // Topology operations (used by the editor)
  // ===========================================================================================

  addDevice(model: string, x: number, y: number): DeviceDoc {
    const d = P.addDevice(this.doc, model, x, y);
    this.devices.set(d.id, this.bootDevice(d));
    this.refresh();
    return d;
  }

  removeDevice(id: string): void {
    P.removeDevice(this.doc, id);
    this.devices.delete(id);
    this.clearPrevState(id);
    this.refresh();
  }

  addLink(cable: CableType, a: { device: string; port: string }, b: { device: string; port: string }): LinkDoc {
    const l = P.addLink(this.doc, cable, a, b);
    this.refresh();
    return l;
  }

  removeLink(id: string): void {
    P.removeLink(this.doc, id);
    this.refresh();
  }

  setModule(id: string, bay: string, module: string | null): void {
    P.setModule(this.doc, id, bay, module);
    const d = this.dev(id);
    d.buildPorts();
    if (d.ios) {
      for (const p of d.dataPorts()) if (!d.ios.interfaces.has(p)) d.ios.interfaces.set(p, defaultIosConfig(d.spec, [p]).interfaces.get(p)!);
      for (const name of [...d.ios.interfaces.keys()]) {
        const base = name.split('.')[0]!;
        if (!name.startsWith('Vlan') && !d.ports.has(base)) d.ios.interfaces.delete(name);
      }
    }
    this.refresh();
  }

  renameDevice(id: string, name: string): void {
    const n = name.trim().slice(0, P.LIMITS.nameLength);
    if (!n) throw new P.ModelError('invalid_name', 'Name cannot be empty');
    this.dev(id).doc.name = n;
  }

  moveDevices(moves: { id: string; x: number; y: number }[]): void {
    for (const m of moves) {
      const d = this.dev(m.id).doc;
      d.x = Math.round(m.x);
      d.y = Math.round(m.y);
    }
  }

  /** Copy/paste: clones devices (configuration included) and the links between them. */
  duplicate(ids: string[], dx: number, dy: number): string[] {
    const map = new Map<string, string>();
    for (const id of ids) {
      const src = this.dev(id);
      if (src.ios) src.doc.running = this.runningConfig(src);
      const d = P.addDevice(this.doc, src.doc.model, src.doc.x + dx, src.doc.y + dy);
      d.modules = { ...src.doc.modules };
      if (src.doc.running !== undefined) d.running = src.doc.running;
      if (src.doc.vlanDb) d.vlanDb = structuredClone(src.doc.vlanDb);
      if (src.doc.host) d.host = { ...src.doc.host, ip: '' }; // a pasted PC must not duplicate an address
      d.powered = src.doc.powered;
      this.devices.set(d.id, this.bootDevice(d));
      map.set(id, d.id);
    }
    for (const l of [...this.doc.links]) {
      const a = map.get(l.a.device);
      const b = map.get(l.b.device);
      if (a && b) P.addLink(this.doc, l.cable, { device: a, port: l.a.port }, { device: b, port: l.b.port });
    }
    this.refresh();
    return [...map.values()];
  }

  /** Imports a validated selection with fresh ids/MACs while preserving its internal links and configuration. */
  pasteSelection(selection: unknown, dx: number, dy: number): string[] {
    const source = P.validateProject(selection);
    if (this.doc.devices.length + source.devices.length > P.LIMITS.devices) throw new P.ModelError('limit', `A project is limited to ${P.LIMITS.devices} devices`);
    if (this.doc.links.length + source.links.length > P.LIMITS.links) throw new P.ModelError('limit', `A project is limited to ${P.LIMITS.links} links`);
    if (this.doc.notes.length + source.notes.length > P.LIMITS.notes || this.doc.zones.length + source.zones.length > P.LIMITS.notes) {
      throw new P.ModelError('limit', `A project is limited to ${P.LIMITS.notes} annotations of each type`);
    }

    const map = new Map<string, string>();
    for (const original of source.devices) {
      const copy = P.addDevice(this.doc, original.model, original.x + dx, original.y + dy);
      copy.modules = { ...original.modules };
      copy.running = original.running ?? '';
      copy.startup = original.startup ?? null;
      if (original.vlanDb) copy.vlanDb = structuredClone(original.vlanDb);
      if (original.rsaModulus !== undefined) copy.rsaModulus = original.rsaModulus;
      if (original.host) copy.host = structuredClone(original.host);
      if (original.services) copy.services = structuredClone(original.services);
      if (original.wireless) copy.wireless = structuredClone(original.wireless);
      copy.powered = original.powered;
      this.devices.set(copy.id, this.bootDevice(copy));
      map.set(original.id, copy.id);
    }
    for (const link of source.links) {
      P.addLink(this.doc, link.cable, { device: map.get(link.a.device)!, port: link.a.port }, { device: map.get(link.b.device)!, port: link.b.port });
    }
    const pasted: string[] = [...map.values()];
    for (const note of source.notes) {
      const id = this.addNote(note.x + dx, note.y + dy, note.text);
      this.updateAnnotation(id, { color: note.color });
      pasted.push(id);
    }
    for (const zone of source.zones) {
      const id = this.addZone(zone.x + dx, zone.y + dy, zone.w, zone.h, zone.label);
      this.updateAnnotation(id, { color: zone.color });
      pasted.push(id);
    }
    this.refresh();
    return pasted;
  }

  addNote(x: number, y: number, text: string): string {
    const id = `n${++this.doc.counters.note}`;
    this.doc.notes.push({ id, x: Math.round(x), y: Math.round(y), text: text.slice(0, P.LIMITS.noteLength), color: '#facc15' });
    return id;
  }

  addZone(x: number, y: number, w: number, h: number, label: string): string {
    const id = `z${++this.doc.counters.note}`;
    this.doc.zones.push({ id, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), label: label.slice(0, P.LIMITS.nameLength), color: '#6366f1' });
    return id;
  }

  updateAnnotation(id: string, patch: Partial<{ x: number; y: number; w: number; h: number; text: string; label: string; color: string }>): void {
    const item = this.doc.notes.find((n) => n.id === id) ?? this.doc.zones.find((z) => z.id === id);
    if (!item) throw new P.ModelError('not_found', `No annotation ${id}`);
    if (patch.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new P.ModelError('invalid', 'Invalid colour');
    Object.assign(item, patch);
  }

  removeAnnotation(id: string): void {
    this.doc.notes = this.doc.notes.filter((n) => n.id !== id);
    this.doc.zones = this.doc.zones.filter((z) => z.id !== id);
  }

  /** Simulation mode "Reset Simulation": drops in-flight frames and the event list. */
  resetSimulation(): void {
    this.queue = [];
    this.waiters.clear();
    this.log = [];
  }

  setServices(id: string, services: unknown): void {
    const d = this.dev(id);
    if (d.spec.role !== 'server') throw new P.ModelError('not_server', 'Only servers have services');
    d.doc.services = P.validateServices(services);
  }

  setWireless(id: string, cfg: { ssid: string; security: 'open' | 'wpa2'; key: string }): void {
    const d = this.dev(id);
    if (!this.isWirelessAccessPoint(d)) throw new P.ModelError('not_ap', 'Device has no configurable wireless access point');
    const ssid = String(cfg.ssid ?? '').slice(0, 32);
    const key = String(cfg.key ?? '').slice(0, 63);
    if (!ssid) throw new P.ModelError('invalid_ssid', 'SSID cannot be empty');
    if (cfg.security === 'wpa2' && key.length < 8) throw new P.ModelError('invalid_wpa_key', 'WPA2 passphrase must be at least 8 characters');
    d.doc.wireless = { ssid, security: cfg.security === 'wpa2' ? 'wpa2' : 'open', key };
    this.refresh();
  }

  setHostConfig(id: string, cfg: Partial<HostConfig>): void {
    const d = this.dev(id);
    if (!d.doc.host) throw new P.ModelError('not_host', 'Not an end device');
    const next = { ...d.doc.host, ...cfg };
    for (const f of ['ip', 'mask', 'gateway', 'dns'] as const) {
      if (next[f] !== '' && parseIp(next[f]) === null) throw new P.ModelError(f === 'ip' ? 'invalid_ip' : `invalid_${f}`, `Invalid ${f}`);
    }
    if (next.mask && maskToPrefix(parseIp(next.mask)!) === null) throw new P.ModelError('invalid_mask', 'Invalid subnet mask');
    if (next.ip && next.mask && !isUsableHost(parseIp(next.ip)!, parseIp(next.mask)!)) throw new P.ModelError('invalid_host', 'Network or broadcast address is not a valid host address');
    if (next.ipv6 && (!parseCidr6(next.ipv6) || isLinkLocal(parseCidr6(next.ipv6)!.ip))) throw new P.ModelError('invalid_ipv6', 'Invalid IPv6 address/prefix');
    if (next.ipv6Gateway && parseIp6(next.ipv6Gateway) === null) throw new P.ModelError('invalid_ipv6', 'Invalid IPv6 gateway');
    if (next.ipv6Mode !== undefined && !['static', 'slaac', 'dhcpv6'].includes(next.ipv6Mode)) throw new P.ModelError('invalid_ipv6', 'Invalid IPv6 mode');
    if (next.wifi) next.wifi = { ssid: String(next.wifi.ssid ?? '').slice(0, 32), key: String(next.wifi.key ?? '').slice(0, 63) };
    const changedIp = next.ip !== d.doc.host.ip || next.mask !== d.doc.host.mask;
    const changedIpv6 = next.ipv6 !== d.doc.host.ipv6 || next.ipv6Gateway !== d.doc.host.ipv6Gateway || next.ipv6Mode !== d.doc.host.ipv6Mode;
    d.doc.host = next;
    if (changedIpv6) {
      d.nd.clear();
      d.pendingNd.clear();
    }
    if (changedIp) {
      d.arp.clear();
      d.ipConflict = undefined;
    }
    this.refresh();
    if (changedIp) this.gratuitousArp(d, this.hostIf(d));
  }

  // ===========================================================================================
  // Layer 1 / interface status
  // ===========================================================================================

  linkOf(device: string, port: string): LinkDoc | undefined {
    return P.linkOnPort(this.doc, device, port);
  }

  peer(device: string, port: string): { device: string; port: string; link: LinkDoc } | undefined {
    const l = this.linkOf(device, port);
    if (!l) return undefined;
    const other = l.a.device === device && l.a.port === port ? l.b : l.a;
    return { ...other, link: l };
  }

  private portAdminDown(d: RtDevice, port: string): boolean {
    if (d.kind === 'hub' || d.kind === 'ap') return false;
    const media = d.ports.get(port)?.spec.media;
    if (media === 'console' || media === 'rs232') return false;
    if (d.host) return !d.host.portUp;
    return d.ios?.interfaces.get(port)?.shutdown ?? false;
  }

  private computePortStatus(d: RtDevice, port: string): PortStatus {
    const adminDown = this.portAdminDown(d, port);
    if (d.ports.get(port)?.spec.media === 'wireless') {
      if (!d.doc.powered || adminDown) return { adminDown, l1: false, proto: false };
      const up = this.isWirelessAccessPoint(d) ? true : !!this.association(d);
      return { adminDown, l1: up, proto: up };
    }
    const pr = this.peer(d.doc.id, port);
    if (!pr && d.doc.model === 'WirelessRouter-PT' && port.startsWith('GigabitEthernet') && !adminDown && d.doc.powered) {
      const radioUp = !this.portAdminDown(d, 'Wireless0') && this.isWirelessAccessPoint(d);
      return { adminDown, l1: radioUp, proto: radioUp };
    }
    if (!pr || !d.doc.powered) return { adminDown, l1: false, proto: false };
    const o = this.devices.get(pr.device)!;
    const mySpec = d.ports.get(port)!.spec;
    const otherSpec = o.ports.get(pr.port)!.spec;
    let l1 = o.doc.powered && !adminDown && !this.portAdminDown(o, pr.port);
    if (l1 && !copperPinoutOk(pr.link.cable, d.kind, mySpec, o.kind, otherSpec)) l1 = false;
    if (l1 && mySpec.media === 'copper') {
      const s1 = d.ios?.interfaces.get(port)?.speed ?? 'auto';
      const s2 = o.ios?.interfaces.get(pr.port)?.speed ?? 'auto';
      if (s1 !== 'auto' && s2 !== 'auto' && s1 !== s2) l1 = false;
      if (s1 !== 'auto' && Number(s1) > otherSpec.speed) l1 = false;
      if (s2 !== 'auto' && Number(s2) > mySpec.speed) l1 = false;
    }
    let proto = l1;
    if (l1 && mySpec.media === 'serial') {
      const dce = this.serialDce(pr.link);
      const dceDev = this.devices.get(dce.device)!;
      proto = !!dceDev.ios?.interfaces.get(dce.port)?.clockRate;
    }
    return { adminDown, l1, proto };
  }

  serialDce(l: LinkDoc): { device: string; port: string } {
    return l.cable === 'serial-dte' ? l.b : l.a;
  }

  portStatus(device: string, port: string): PortStatus {
    return this.status.get(`${device}|${port}`) ?? { adminDown: false, l1: false, proto: false };
  }

  /** IOS interface status (physical, subinterface or SVI). */
  ifStatus(d: RtDevice, name: string): PortStatus {
    const cfg = d.ios?.interfaces.get(name);
    if (!d.doc.powered) return { adminDown: cfg?.shutdown ?? false, l1: false, proto: false };
    if (name.startsWith('Vlan')) {
      const vlan = Number(name.slice(4));
      const adminDown = cfg?.shutdown ?? true;
      if (adminDown || !this.vlanExists(d, vlan)) return { adminDown, l1: false, proto: false };
      const up = d.dataPorts().some((p) => this.portInVlan(d, p, vlan) && this.stpForwarding(d, p, vlan));
      return { adminDown, l1: up, proto: up };
    }
    if (name.startsWith('Loopback')) {
      const adminDown = cfg?.shutdown ?? false;
      return { adminDown, l1: !adminDown, proto: !adminDown };
    }
    if (name.includes('.')) {
      const parent = this.portStatus(d.doc.id, name.split('.')[0]!);
      const adminDown = (cfg?.shutdown ?? false) || parent.adminDown;
      return { adminDown, l1: !adminDown && parent.l1, proto: !adminDown && parent.proto };
    }
    return this.portStatus(d.doc.id, name);
  }

  ifUp(d: RtDevice, name: string): boolean {
    if (d.host) return this.portStatus(d.doc.id, this.hostIf(d)).proto;
    return this.ifStatus(d, name).proto;
  }

  /** The NIC an end device currently uses: wired when its cable is up, else the wireless card. */
  hostIf(d: RtDevice): string {
    const wired = d.ports.has('FastEthernet0');
    const wireless = d.ports.has('Wireless0');
    if (wired && (!wireless || this.portStatus(d.doc.id, 'FastEthernet0').l1)) return 'FastEthernet0';
    return wireless ? 'Wireless0' : 'FastEthernet0';
  }

  private isWirelessAccessPoint(d: RtDevice): boolean {
    return d.kind === 'ap' || (d.kind === 'router' && d.ports.has('Wireless0') && !!d.doc.wireless);
  }

  /** Access point a wireless client is associated with (matching SSID / key, powered, in range). */
  association(d: RtDevice): RtDevice | undefined {
    const w = d.host?.wifi;
    if (!w || !d.doc.powered || !d.host!.portUp) return undefined;
    let best: RtDevice | undefined;
    let bestDist = Infinity;
    for (const ap of this.devices.values()) {
      if (!this.isWirelessAccessPoint(ap) || !ap.doc.powered || !ap.doc.wireless) continue;
      const cfg = ap.doc.wireless;
      if (cfg.ssid !== w.ssid) continue;
      if (cfg.security === 'wpa2' && (cfg.key.length < 8 || cfg.key !== w.key)) continue;
      const dist = Math.hypot(ap.doc.x - d.doc.x, ap.doc.y - d.doc.y);
      if (dist <= WIFI_RANGE && dist < bestDist) {
        best = ap;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Wireless associations, for drawing on the canvas. */
  wirelessLinks(): { client: string; ap: string }[] {
    const out: { client: string; ap: string }[] = [];
    for (const d of this.devices.values()) {
      if (!d.ports.has('Wireless0')) continue;
      const ap = this.association(d);
      if (ap) out.push({ client: d.doc.id, ap: ap.doc.id });
    }
    return out;
  }

  /** Link LED colour for one end, as shown on the canvas. */
  light(device: string, port: string): LinkLight {
    const d = this.devices.get(device);
    if (!d) return 'off';
    const media = d.ports.get(port)?.spec.media;
    const st = this.portStatus(device, port);
    if (media === 'console' || media === 'rs232') return st.l1 ? 'green' : 'red';
    if (media === 'wireless') return st.proto ? 'green' : 'off';
    if (!st.l1) return 'red';
    if (!st.proto) return 'red';
    const cfg = d.ios?.interfaces.get(port);
    if (cfg?.switchport) {
      const vlans = this.portVlans(d, port);
      if (vlans.length === 0) return 'amber';
      if (vlans.some((v) => this.stpForwarding(d, port, v))) return 'green';
      return 'amber';
    }
    return 'green';
  }

  // ===========================================================================================
  // Switching: VLAN membership, DTP, STP
  // ===========================================================================================

  vlanExists(d: RtDevice, vlan: number): boolean {
    if (vlan === 1 || (vlan >= 1002 && vlan <= 1005)) return true;
    return !!d.doc.vlanDb?.some((v) => v.id === vlan);
  }

  allVlans(d: RtDevice): { id: number; name: string }[] {
    const out = [{ id: 1, name: 'default' }, ...(d.doc.vlanDb ?? [])];
    out.push({ id: 1002, name: 'fddi-default' }, { id: 1003, name: 'token-ring-default' }, { id: 1004, name: 'fddinet-default' }, { id: 1005, name: 'trnet-default' });
    return out.sort((a, b) => a.id - b.id);
  }

  isTrunk(d: RtDevice, port: string): boolean {
    return this.operTrunk.get(`${d.doc.id}|${port}`) ?? false;
  }

  private computeTrunk(d: RtDevice, port: string): boolean {
    const cfg = d.ios?.interfaces.get(port);
    if (!cfg?.switchport) return false;
    if (cfg.mode === 'trunk') return true;
    if (cfg.mode === 'access') return false;
    const pr = this.peer(d.doc.id, port);
    if (!pr) return false;
    const o = this.devices.get(pr.device)!;
    const oc = o.ios?.interfaces.get(pr.port);
    if (!oc?.switchport) return false;
    if (cfg.mode === 'dynamic desirable') return oc.mode !== 'access';
    return oc.mode === 'trunk' || oc.mode === 'dynamic desirable';
  }

  trunkAllows(cfg: IfConfig, vlan: number): boolean {
    return cfg.allowed === null || cfg.allowed.includes(vlan);
  }

  portInVlan(d: RtDevice, port: string, vlan: number): boolean {
    const cfg = d.ios?.interfaces.get(port);
    if (!cfg?.switchport || !this.portStatus(d.doc.id, port).proto) return false;
    if (this.isTrunk(d, port)) return this.trunkAllows(cfg, vlan) && this.vlanExists(d, vlan);
    return cfg.accessVlan === vlan && this.vlanExists(d, vlan);
  }

  /** VLANs a switch port actively carries. */
  portVlans(d: RtDevice, port: string): number[] {
    const cfg = d.ios?.interfaces.get(port);
    if (!cfg?.switchport) return [];
    if (this.isTrunk(d, port)) return this.allVlans(d).map((v) => v.id).filter((v) => v < 1002 && this.trunkAllows(cfg, v));
    return this.vlanExists(d, cfg.accessVlan) ? [cfg.accessVlan] : [];
  }

  stpRole(d: RtDevice, port: string, vlan: number): StpRole | undefined {
    return this.stpRoles.get(vlan)?.get(`${d.doc.id}|${port}`);
  }

  stpState(d: RtDevice, port: string, vlan: number): 'FWD' | 'BLK' | 'LIS' | 'LRN' | 'DIS' {
    const role = this.stpRole(d, port, vlan);
    if (!role) return 'DIS';
    if (role === 'alternate') return 'BLK';
    const cfg = d.ios?.interfaces.get(port);
    if (cfg?.portfast && !this.isTrunk(d, port)) return 'FWD';
    const since = this.stpSince.get(`${vlan}|${d.doc.id}|${port}`) ?? -Infinity;
    const el = this.now - since;
    if (el >= 2 * FORWARD_DELAY) return 'FWD';
    return el >= FORWARD_DELAY ? 'LRN' : 'LIS';
  }

  stpForwarding(d: RtDevice, port: string, vlan: number): boolean {
    return this.stpState(d, port, vlan) === 'FWD';
  }

  stpInfo(d: RtDevice, vlan: number) {
    return this.stpRoot.get(vlan)?.get(d.doc.id);
  }

  bridgePriority(d: RtDevice, vlan: number): number {
    return (d.ios?.stpPriority.get(vlan) ?? 32768) + vlan;
  }

  private computeStpAll(): void {
    const switches = [...this.devices.values()].filter((d) => (d.kind === 'switch' || d.kind === 'l3switch') && d.doc.powered);
    const vlans = new Set<number>();
    for (const s of switches) for (const v of this.allVlans(s)) if (v.id < 1002) vlans.add(v.id);
    const newRoles = new Map<number, Map<string, StpRole>>();
    this.stpRoot.clear();
    for (const vlan of vlans) {
      const bridges: StpBridge[] = [];
      for (const s of switches) {
        if (!this.vlanExists(s, vlan)) continue;
        const ports = s.dataPorts().filter((p) => this.portInVlan(s, p, vlan)).map((p) => {
          const rp = s.ports.get(p)!;
          return { name: p, index: rp.index + 1, cost: portCost(rp.spec.speed), segment: this.segmentKey(s.doc.id, p) };
        });
        bridges.push({ id: s.doc.id, priority: this.bridgePriority(s, vlan), mac: s.doc.macBase, ports });
      }
      const res = computeStp(bridges);
      newRoles.set(vlan, res.roles);
      const info = new Map<string, { root: string; cost: number; rootPort?: string; bridges: StpBridge[] }>();
      for (const b of bridges) {
        const rp = res.rootPort.get(b.id);
        info.set(b.id, { root: res.rootOf.get(b.id)!, cost: res.rootCost.get(b.id) ?? 0, ...(rp ? { rootPort: rp } : {}), bridges });
      }
      this.stpRoot.set(vlan, info);
    }
    // Role-change timestamps drive listening -> learning -> forwarding.
    for (const [vlan, roles] of newRoles) {
      const old = this.stpRoles.get(vlan);
      for (const [key, role] of roles) {
        const prev = old?.get(key);
        const k = `${vlan}|${key}`;
        if (role === 'alternate') this.stpSince.delete(k);
        else if (!prev || prev === 'alternate') this.stpSince.set(k, this.initializing ? -Infinity : this.now);
      }
      if (old) for (const key of old.keys()) if (!roles.has(key)) this.stpSince.delete(`${vlan}|${key}`);
    }
    this.stpRoles = newRoles;
  }

  /** A broadcast segment: the far end of a link, extended through hubs. */
  private segmentKey(device: string, port: string): string {
    const pr = this.peer(device, port);
    if (!pr) return `${device}|${port}`;
    const o = this.devices.get(pr.device)!;
    if (o.kind !== 'hub') return [`${device}|${port}`, `${pr.device}|${pr.port}`].sort().join('~');
    return `hub:${pr.device}`;
  }

  // ===========================================================================================
  // refresh(): recompute derived state after any change
  // ===========================================================================================

  refresh(): void {
    this.version++;
    this.status.clear();
    for (const d of this.devices.values()) for (const p of d.portOrder) this.status.set(`${d.doc.id}|${p}`, this.computePortStatus(d, p));
    this.operTrunk.clear();
    for (const d of this.devices.values()) if (d.ios) for (const p of d.dataPorts()) this.operTrunk.set(`${d.doc.id}|${p}`, this.computeTrunk(d, p));
    this.computeStpAll();
    for (const d of this.devices.values()) this.diffInterfaces(d);
  }

  private diffInterfaces(d: RtDevice): void {
    const names = d.ios ? [...d.ios.interfaces.keys()] : d.host ? d.dataPorts() : [];
    for (const name of names) {
      const st = d.ios ? this.ifStatus(d, name) : this.portStatus(d.doc.id, name);
      const key = `${d.doc.id}|${name}`;
      const state = st.adminDown ? 'admin' : st.proto ? 'up' : st.l1 ? 'updown' : 'down';
      const prev = this.prevIfState.get(key);
      this.prevIfState.set(key, state);
      if (prev === undefined || prev === state) continue;
      if (state !== 'up') this.flushInterface(d, name);
      if (!d.ios || !d.doc.powered) continue;
      const wasL1 = prev === 'up' || prev === 'updown';
      const isL1 = state === 'up' || state === 'updown';
      if (wasL1 !== isL1 || state === 'admin') {
        const tag = state === 'admin' || isL1 ? 'LINK-5-CHANGED' : 'LINK-3-UPDOWN';
        this.console(d.doc.id, `%${tag}: Interface ${name}, changed state to ${state === 'admin' ? 'administratively down' : isL1 ? 'up' : 'down'}`);
      }
      const wasUp = prev === 'up';
      if (wasUp !== (state === 'up')) this.console(d.doc.id, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to ${state === 'up' ? 'up' : 'down'}`);
      if (state === 'up' && !name.startsWith('Vlan') && !this.initializing) this.gratuitousArp(d, name);
    }
  }

  private flushInterface(d: RtDevice, name: string): void {
    for (const [ip, e] of d.arp) if (e.iface === name) d.arp.delete(ip);
    for (const [k, e] of d.macTable) if (e.port === name) d.macTable.delete(k);
    for (const [ip, e] of d.nd) if (e.iface === name) d.nd.delete(ip);
  }

  console(device: string, text: string): void {
    this.onConsole?.(device, text);
  }

  // ===========================================================================================
  // Layer 3 interfaces and routing table
  // ===========================================================================================

  l3Ifs(d: RtDevice): L3If[] {
    if (d.host) {
      const h = d.host;
      const ip = parseIp(h.ip);
      const mask = parseIp(h.mask);
      if (ip === null || mask === null) return [];
      const name = this.hostIf(d);
      return [{ name, ip, mask, mac: d.ports.get(name)!.mac }];
    }
    if (!d.ios) return [];
    const out: L3If[] = [];
    for (const cfg of d.ios.interfaces.values()) {
      if (!cfg.ip || cfg.switchport) continue;
      out.push({ name: cfg.name, ip: cfg.ip.address, mask: cfg.ip.mask, mac: this.ifMac(d, cfg.name) });
    }
    return out;
  }

  ifMac(d: RtDevice, name: string): string {
    if (name.startsWith('Vlan')) return d.sviMac();
    const port = d.ports.get(name.split('.')[0]!);
    return port?.mac ?? d.doc.macBase;
  }

  routingEnabled(d: RtDevice): boolean {
    return !!d.ios && d.ios.ipRouting && d.kind !== 'switch';
  }

  routes(d: RtDevice): Route[] {
    const cached = this.routeCache.get(d.doc.id);
    if (cached && cached.version === this.version) return cached.routes;
    const routes = this.computeRoutes(d);
    this.routeCache.set(d.doc.id, { version: this.version, routes });
    return routes;
  }

  private computeRoutes(d: RtDevice): Route[] {
    const out: Route[] = [];
    if (!d.doc.powered) return out;
    for (const i of this.l3Ifs(d)) {
      if (!this.ifUp(d, i.name)) continue;
      out.push({ type: 'C', network: networkOf(i.ip, i.mask), mask: i.mask, ad: 0, metric: 0, iface: i.name });
      if (d.spec.localRoutes && maskToPrefix(i.mask) !== 32) out.push({ type: 'L', network: i.ip, mask: 0xffffffff, ad: 0, metric: 0, iface: i.name });
    }
    if (!this.routingEnabled(d)) return out;
    const statics = d.ios!.staticRoutes;
    const dynamic = this.dynamic().routes.get(d.doc.id) ?? [];
    const installed: Route[] = [];
    // Iterate to a fixpoint so recursive next hops resolve through other static routes.
    for (let round = 0; round < 4; round++) {
      let changed = false;
      for (const s of statics) {
        if (installed.some((r) => r.network === s.network && r.mask === s.mask && r.nextHop === s.nextHop && r.iface === s.iface)) continue;
        let ok = false;
        if (s.iface) ok = this.ifUp(d, s.iface);
        else if (s.nextHop !== undefined) {
          const via = this.lookupIn([...out, ...installed].filter((r) => !(r.network === s.network && r.mask === s.mask)), s.nextHop);
          ok = !!via;
        }
        if (ok) {
          installed.push({ type: 'S', network: s.network, mask: s.mask, ad: s.distance, metric: 0, ...(s.nextHop !== undefined ? { nextHop: s.nextHop } : {}), ...(s.iface ? { iface: s.iface } : {}), ...(s.mask === 0 ? { candidateDefault: true } : {}) });
          changed = true;
        }
      }
      if (!changed) break;
    }
    // Keep the best administrative distance per prefix.
    for (const r of [...installed, ...dynamic]) {
      const same = out.filter((x) => x.network === r.network && x.mask === r.mask && x.type !== 'L');
      const best = Math.min(...same.map((x) => x.ad), Infinity);
      if (r.ad < best) {
        for (const x of same) out.splice(out.indexOf(x), 1);
        out.push(r);
      } else if (r.ad === best) out.push(r);
    }
    return out;
  }

  /** RIP / OSPF state, recomputed when the topology or configuration changes. */
  dynamic(): DynamicResult {
    if (!this.dyn || this.dyn.version !== this.version) this.dyn = { version: this.version, res: computeDynamic(this) };
    return this.dyn.res;
  }

  /**
   * Layer-3 endpoints sharing the broadcast domain of an interface: walks cables, hubs, access
   * points and switches (VLAN membership, trunks, STP forwarding state) like a broadcast would.
   */
  broadcastDomain(d: RtDevice, ifName: string): { dev: RtDevice; iface: L3If }[] {
    return this.broadcastDomainFor(d, ifName, (dev, name) => this.l3Ifs(dev).find((x) => x.name === name));
  }

  broadcastDomain6(d: RtDevice, ifName: string): { dev: RtDevice; iface: L3If6 }[] {
    return this.broadcastDomainFor(d, ifName, (dev, name) => this.l3Ifs6(dev).find((x) => x.name === name));
  }

  private broadcastDomainFor<T extends { name: string }>(d: RtDevice, ifName: string, getIface: (dev: RtDevice, name: string) => T | undefined): { dev: RtDevice; iface: T }[] {
    const out: { dev: RtDevice; iface: T }[] = [];
    const seen = new Set<string>();
    const add = (dev: RtDevice, name: string) => {
      const i = getIface(dev, name);
      if (i && this.ifUp(dev, name) && !out.some((o) => o.dev === dev && o.iface.name === name)) out.push({ dev, iface: i });
    };
    const visitSwitch = (sw: RtDevice, vlan: number, ingress?: string) => {
      const key = `sw|${sw.doc.id}|${vlan}`;
      if (seen.has(key)) return;
      seen.add(key);
      add(sw, `Vlan${vlan}`);
      for (const p of sw.dataPorts()) {
        if (p === ingress || !this.portInVlan(sw, p, vlan) || !this.stpForwarding(sw, p, vlan)) continue;
        const cfg = sw.ios!.interfaces.get(p)!;
        walk(sw, p, this.isTrunk(sw, p) && vlan !== cfg.nativeVlan ? vlan : undefined);
      }
    };
    const arrive = (o: RtDevice, op: string, tag: number | undefined) => {
      const key = `${o.doc.id}|${op}|${tag ?? ''}`;
      if (seen.has(key) || !o.doc.powered) return;
      seen.add(key);
      if (o.kind === 'hub' || o.kind === 'ap') {
        for (const q of o.dataPorts()) if (q !== op) walk(o, q, tag);
        return;
      }
      const cfg = o.ios?.interfaces.get(op);
      if ((o.kind === 'switch' || o.kind === 'l3switch') && cfg?.switchport) {
        if (!this.stpForwarding(o, op, this.isTrunk(o, op) ? (tag ?? cfg.nativeVlan) : cfg.accessVlan)) return;
        if (this.isTrunk(o, op)) {
          const vlan = tag ?? cfg.nativeVlan;
          if (this.trunkAllows(cfg, vlan)) visitSwitch(o, vlan, op);
        } else if (tag === undefined) visitSwitch(o, cfg.accessVlan, op);
        return;
      }
      if (o.host) return add(o, op);
      if (o.ios) {
        const subs = [...o.ios.interfaces.values()].filter((c) => c.name.startsWith(op + '.') && c.dot1q);
        const sub = tag !== undefined ? subs.find((c) => c.dot1q!.vlan === tag) : subs.find((c) => c.dot1q!.native);
        if (sub) add(o, sub.name);
        else if (tag === undefined) add(o, op);
      }
    };
    const walk = (from: RtDevice, port: string, tag: number | undefined) => {
      if (!this.portStatus(from.doc.id, port).proto) return;
      if (from.ports.get(port)?.spec.media === 'wireless') {
        if (from.kind === 'ap') {
          for (const c of this.devices.values()) if (this.association(c) === from) arrive(c, 'Wireless0', tag);
        } else {
          const ap = this.association(from);
          if (ap) arrive(ap, 'Port 1', tag);
        }
        return;
      }
      const pr = this.peer(from.doc.id, port);
      if (pr) arrive(this.devices.get(pr.device)!, pr.port, tag);
    };
    if (ifName.startsWith('Vlan')) visitSwitch(d, Number(ifName.slice(4)));
    else {
      const [port, sub] = ifName.split('.');
      const dq = sub ? d.ios?.interfaces.get(ifName)?.dot1q : undefined;
      seen.add(`${d.doc.id}|${port}|${dq && !dq.native ? dq.vlan : ''}`);
      walk(d, port!, dq && !dq.native ? dq.vlan : undefined);
    }
    return out;
  }

  private lookupIn(routes: Route[], dst: number): Route | undefined {
    let best: Route | undefined;
    for (const r of routes) {
      if (networkOf(dst, r.mask) !== r.network) continue;
      if (!best || r.mask >>> 0 > best.mask >>> 0) best = r;
    }
    return best;
  }

  /** Longest-prefix-match + recursive next-hop resolution. Returns the egress interface and the L2 next hop. */
  resolve(d: RtDevice, dst: number): { iface: string; nextHop: number; route?: Route } | null {
    if (d.host || !this.routingEnabled(d)) {
      for (const i of this.l3Ifs(d)) if (this.ifUp(d, i.name) && networkOf(dst, i.mask) === networkOf(i.ip, i.mask)) return { iface: i.name, nextHop: dst };
      if (dst === BROADCAST_IP) {
        const i = this.l3Ifs(d).find((x) => this.ifUp(d, x.name));
        return i ? { iface: i.name, nextHop: dst } : null;
      }
      const gwText = d.host ? d.host.gateway : d.ios?.defaultGateway !== undefined ? ipToString(d.ios.defaultGateway) : '';
      const gw = parseIp(gwText);
      if (gw === null) return null;
      for (const i of this.l3Ifs(d)) if (this.ifUp(d, i.name) && networkOf(gw, i.mask) === networkOf(i.ip, i.mask)) return { iface: i.name, nextHop: gw };
      return null;
    }
    const routes = this.routes(d);
    let target = dst;
    let first: Route | undefined;
    for (let depth = 0; depth < 6; depth++) {
      const r = this.lookupIn(routes, target);
      if (!r) return null;
      first ??= r;
      if (r.iface) return { iface: r.iface, nextHop: r.nextHop ?? (r.type === 'S' ? target : target), route: first };
      target = r.nextHop!;
    }
    return null;
  }

  isLocalAddress(d: RtDevice, ip: number, inIf?: string): boolean {
    if (ip === BROADCAST_IP) return true;
    for (const i of this.l3Ifs(d)) {
      if (i.ip === ip && this.ifUp(d, i.name)) return true;
      if (inIf === i.name && ip === broadcastOf(i.ip, i.mask) && maskToPrefix(i.mask)! < 31) return true;
    }
    return false;
  }

  // ===========================================================================================
  // Event queue
  // ===========================================================================================

  private record(e: Omit<SimEvent, 'seq' | 'at'>): void {
    const ev: SimEvent = { seq: ++this.evSeq, at: this.now, ...e, frame: cloneFrame(e.frame) };
    this.log.push(ev);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    this.onEvent?.(ev);
  }

  private drop(d: RtDevice, f: Frame, reason: Reason, port?: string): void {
    this.record({ device: d.doc.id, kind: 'drop', proto: protoOf(f), info: describeFrame(f), reason, frame: f, ...(port ? { port } : {}) });
  }

  private latency(media: string, speed: number): number {
    if (media === 'serial') return 4;
    return speed >= 1000 ? 0.1 : 0.25;
  }

  /** Puts a frame on the wire. */
  private transmit(d: RtDevice, port: string, f: Frame): void {
    if (d.ports.get(port)?.spec.media === 'wireless') return this.radioTransmit(d, port, f);
    if (d.doc.model === 'WirelessRouter-PT' && port.startsWith('GigabitEthernet') && !this.peer(d.doc.id, port)) {
      return this.radioTransmit(d, 'Wireless0', f);
    }
    const pr = this.peer(d.doc.id, port);
    if (!pr) return this.drop(d, f, dropReason('no_cable', { port }), port);
    if (!this.portStatus(d.doc.id, port).proto) return this.drop(d, f, dropReason('link_down', { port }), port);
    const frame = cloneFrame(f);
    frame.hops++;
    if (frame.hops > L2_HOP_LIMIT) return this.drop(d, f, dropReason('l2_loop'), port);
    const spec = d.ports.get(port)!.spec;
    const at = this.now + this.latency(spec.media, spec.speed);
    this.record({ device: d.doc.id, kind: 'tx', proto: protoOf(frame), info: describeFrame(frame), port, link: pr.link.id, to: pr.device, arrive: at, frame });
    this.enqueue(at, pr.device, pr.port, frame);
  }

  private enqueue(at: number, device: string, port: string, frame: Frame): void {
    this.insertQueueItem({ kind: 'frame', at, seq: ++this.seq, device, port, frame });
  }

  private enqueueTimer(at: number, callback: () => void): void {
    this.insertQueueItem({ kind: 'timer', at, seq: ++this.seq, callback });
  }

  private insertQueueItem(item: QueueItem): void {
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid]!;
      if (q.at < item.at || (q.at === item.at && q.seq < item.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, item);
  }

  /** Schedules a recurring control-plane action that is cancelled by a topology/config change. */
  scheduleRoutingTimer(delay: number, version: number, callback: () => void): void {
    this.enqueueTimer(this.now + delay, () => {
      if (this.version === version) callback();
    });
  }

  /** Radio: a client talks to its AP; the AP delivers to the addressed station (or all, for broadcasts). */
  private radioTransmit(d: RtDevice, port: string, f: Frame): void {
    if (!this.portStatus(d.doc.id, port).proto) return this.drop(d, f, dropReason('wifi_not_associated'), port);
    const frame = cloneFrame(f);
    frame.hops++;
    if (frame.hops > L2_HOP_LIMIT) return this.drop(d, f, dropReason('l2_loop'), port);
    const at = this.now + 0.5;
    const targets: { dev: RtDevice; port: string }[] = [];
    const isAp = this.isWirelessAccessPoint(d);
    if (isAp) {
      for (const c of this.devices.values()) {
        if (this.association(c) !== d) continue;
        const mac = c.ports.get('Wireless0')!.mac;
        if (mac === f.src) continue;
        if (f.dst === BROADCAST_MAC || f.dst === mac) targets.push({ dev: c, port: 'Wireless0' });
      }
    } else {
      const ap = this.association(d);
      if (ap) targets.push({ dev: ap, port: ap.kind === 'ap' ? 'Port 1' : 'Wireless0' });
    }
    for (const t of targets) {
      this.record({ device: d.doc.id, kind: 'tx', proto: protoOf(frame), info: describeFrame(frame), port, link: `wifi:${isAp ? t.dev.doc.id : d.doc.id}`, to: t.dev.doc.id, arrive: at, frame });
      this.enqueue(at, t.dev.doc.id, t.port, frame);
    }
  }

  pendingEvents(): number {
    return this.queue.length;
  }

  nextEventAt(): number | undefined {
    return this.queue[0]?.at;
  }

  /** Processes queued deliveries up to `deadline`, stopping early when `done()` becomes true. */
  runUntil(deadline: number, done: () => boolean = () => false): void {
    while (this.queue.length && this.queue[0]!.at <= deadline) {
      if (--this.budget <= 0) {
        this.queue = [];
        this.record({ device: '', kind: 'drop', proto: 'ETH', info: 'event budget exhausted', reason: dropReason('storm'), frame: { src: '', dst: '', type: 'arp', hops: 0 } });
        break;
      }
      const item = this.queue.shift()!;
      this.now = Math.max(this.now, item.at);
      if (item.kind === 'frame') this.receive(item.device, item.port, item.frame);
      else item.callback();
      if (done()) return;
    }
    this.now = Math.max(this.now, deadline);
    this.budget = EVENT_BUDGET;
  }

  /** Advances the clock (real-time mode). */
  advance(ms: number): void {
    this.runUntil(this.now + ms);
  }

  /** Simulation mode: processes every delivery scheduled at the next timestamp. Returns false if idle. */
  step(): boolean {
    const next = this.queue[0];
    if (!next) return false;
    const at = next.at;
    while (this.queue.length && this.queue[0]!.at === at) {
      const item = this.queue.shift()!;
      this.now = Math.max(this.now, item.at);
      if (item.kind === 'frame') this.receive(item.device, item.port, item.frame);
      else item.callback();
    }
    return true;
  }

  // ===========================================================================================
  // Frame reception
  // ===========================================================================================

  private receive(devId: string, port: string, f: Frame): void {
    const d = this.devices.get(devId);
    if (!d) return;
    if (!d.doc.powered) return this.drop(d, f, dropReason('powered_off'), port);
    if (!this.portStatus(devId, port).proto) return this.drop(d, f, dropReason('link_down', { port }), port);
    if (d.kind === 'hub') {
      for (const p of d.dataPorts()) if (p !== port && this.peer(devId, p)) this.transmit(d, p, f);
      return;
    }
    if (d.kind === 'ap') {
      // Transparent bridge between the Ethernet port and the radio (stations may talk to each other).
      if (f.src) d.macTable.set(`1|${f.src}`, { port, at: this.now, vlan: 1, mac: f.src });
      const e = f.dst !== BROADCAST_MAC ? d.macTable.get(`1|${f.dst}`) : undefined;
      if (e) {
        if (e.port !== port || port === 'Port 1') this.transmit(d, e.port, f);
        return;
      }
      for (const p of d.dataPorts()) if (p !== port || p === 'Port 1') this.transmit(d, p, f);
      return;
    }
    if (d.kind === 'switch' || d.kind === 'l3switch') {
      const cfg = d.ios!.interfaces.get(port);
      if (cfg && !cfg.switchport) return this.endReceive(d, port, f);
      return this.switchReceive(d, port, f);
    }
    this.endReceive(d, port, f);
  }

  private switchReceive(d: RtDevice, port: string, f: Frame): void {
    const cfg = d.ios!.interfaces.get(port)!;
    let vlan: number;
    if (this.isTrunk(d, port)) {
      vlan = f.tag ?? cfg.nativeVlan;
      if (!this.trunkAllows(cfg, vlan)) return this.drop(d, f, dropReason('vlan_not_allowed', { vlan: String(vlan), port }), port);
    } else {
      if (f.tag !== undefined) return this.drop(d, f, dropReason('tagged_on_access', { port }), port);
      vlan = cfg.accessVlan;
    }
    if (!this.vlanExists(d, vlan)) return this.drop(d, f, dropReason('vlan_missing', { vlan: String(vlan) }), port);
    const st = this.stpState(d, port, vlan);
    if (st === 'BLK' || st === 'LIS' || st === 'DIS') return this.drop(d, f, dropReason('stp_blocking', { port, state: st }), port);
    if (f.src && f.src !== BROADCAST_MAC) d.macTable.set(`${vlan}|${f.src}`, { port, at: this.now, vlan, mac: f.src });
    if (st === 'LRN') return this.drop(d, f, dropReason('stp_learning', { port }), port);
    const frame = { ...f };
    delete frame.tag;
    this.switchForward(d, vlan, frame, port);
  }

  /** Switch fabric forwarding inside one VLAN. `ingress` is undefined for frames sent by the switch's own SVI. */
  private switchForward(d: RtDevice, vlan: number, f: Frame, ingress?: string): void {
    const svi = `Vlan${vlan}`;
    const sviCfg = d.ios!.interfaces.get(svi);
    const sviUp = !!sviCfg?.ip && this.ifUp(d, svi);
    if (ingress !== undefined) {
      if (f.dst === d.sviMac()) {
        if (sviUp) return this.l3Receive(d, svi, f);
        return this.drop(d, f, dropReason('svi_down', { iface: svi }));
      }
      if (f.dst === BROADCAST_MAC && sviUp) this.l3Receive(d, svi, cloneFrame(f));
    }
    if (f.dst !== BROADCAST_MAC) {
      const e = d.macTable.get(`${vlan}|${f.dst}`);
      if (e && this.now - e.at < MAC_AGING) {
        if (e.port === ingress) return;
        if (this.stpForwarding(d, e.port, vlan) && this.portInVlan(d, e.port, vlan)) return this.egress(d, e.port, vlan, f);
      }
    }
    for (const p of d.dataPorts()) {
      if (p === ingress) continue;
      if (!this.portInVlan(d, p, vlan) || !this.stpForwarding(d, p, vlan)) continue;
      this.egress(d, p, vlan, f);
    }
  }

  private egress(d: RtDevice, port: string, vlan: number, f: Frame): void {
    const cfg = d.ios!.interfaces.get(port)!;
    const out: Frame = { ...f };
    if (this.isTrunk(d, port) && vlan !== cfg.nativeVlan) out.tag = vlan;
    else delete out.tag;
    this.transmit(d, port, out);
  }

  /** Reception on a router / host / routed port: pick the logical interface, check the destination MAC. */
  private endReceive(d: RtDevice, port: string, f: Frame): void {
    let iface = port;
    if (d.ios) {
      if (d.doc.model === 'WirelessRouter-PT' && port === 'Wireless0') {
        const lan = d.dataPorts()
          .filter((name) => name.startsWith('GigabitEthernet'))
          .map((name) => this.l3If(d, name))
          .find((candidate) => {
            if (!candidate || !this.ifUp(d, candidate.name)) return false;
            if (f.type === 'arp') return candidate.ip === f.arp!.tpa;
            if (f.type === 'ipv4') return candidate.ip === f.ip!.dst;
            const iface6 = this.l3Ifs6(d).find((item) => item.name === candidate.name);
            return !!iface6 && (iface6.ll === f.ip6!.dst || iface6.addrs.some((address) => address.ip === f.ip6!.dst));
          });
        if (lan) iface = lan.name;
      }
      const subs = [...d.ios.interfaces.values()].filter((c) => c.name.startsWith(port + '.') && c.dot1q);
      if (f.tag !== undefined) {
        const sub = subs.find((c) => c.dot1q!.vlan === f.tag);
        if (!sub) return this.drop(d, f, dropReason('no_subinterface', { vlan: String(f.tag), port }), port);
        iface = sub.name;
      } else {
        const nat = subs.find((c) => c.dot1q!.native);
        if (nat) iface = nat.name;
      }
      if (!this.ifUp(d, iface)) return this.drop(d, f, dropReason('iface_down', { iface }), port);
    } else if (f.tag !== undefined) return this.drop(d, f, dropReason('tagged_on_access', { port }), port);
    const ipv6Multicast = f.type === 'ipv6' && f.dst.startsWith('3333');
    const ipv4Multicast = f.type === 'ipv4' && f.dst.startsWith('01005e');
    if (!f.hdlc && f.dst !== BROADCAST_MAC && f.dst !== this.ifMac(d, iface) && !ipv6Multicast && !ipv4Multicast) return this.drop(d, f, dropReason('not_my_mac'), port);
    this.l3Receive(d, iface, f);
  }

  // ===========================================================================================
  // Layer 3: ARP, IPv4
  // ===========================================================================================

  private l3If(d: RtDevice, name: string): L3If | undefined {
    return this.l3Ifs(d).find((i) => i.name === name);
  }

  private l3Receive(d: RtDevice, ifName: string, f: Frame): void {
    if (f.type === 'arp') return this.handleArp(d, ifName, f);
    if (f.type === 'ipv6') return this.receive6(d, ifName, f);
    let p = f.ip!;
    if (d.ios) {
      const cfg = d.ios.interfaces.get(ifName);
      if (cfg?.aclIn && !this.aclPermits(d, cfg.aclIn, p)) {
        this.drop(d, f, dropReason('acl_in', { acl: cfg.aclIn, iface: ifName }));
        return this.icmpError(d, p, 3, 13);
      }
      if (cfg?.natOutside) p = natInbound(d, ifName, p);
    }
    const routingControl = !!d.ios && (p.proto === 'ospf' || (p.proto === 'udp' && p.udp?.dport === 520));
    const local = this.isLocalAddress(d, p.dst, ifName) || routingControl;
    if (local) return this.localDeliver(d, ifName, p, f);
    if (this.routingEnabled(d)) return this.forward(d, ifName, p, f);
    this.drop(d, f, dropReason('not_for_me'));
  }

  private handleArp(d: RtDevice, ifName: string, f: Frame): void {
    const a = f.arp!;
    const me = this.l3If(d, ifName);
    if (!me) return this.drop(d, f, dropReason('no_ip', { iface: ifName }));
    if (a.spa === me.ip && a.sha !== me.mac) {
      // Someone else uses our address.
      if (d.host) d.ipConflict = a.sha;
      if (d.ios) this.console(d.doc.id, `%IP-4-DUPADDR: Duplicate address ${ipToString(me.ip)} on ${ifName}, sourced by ${macCisco(a.sha)}`);
      return this.drop(d, f, dropReason('ip_conflict', { ip: ipToString(me.ip), mac: macCisco(a.sha) }));
    }
    const sameNet = networkOf(a.spa, me.mask) === networkOf(me.ip, me.mask);
    if (a.tpa === me.ip) {
      if (sameNet) this.learnArp(d, a.spa, a.sha, ifName);
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'ARP', info: describeFrame(f), frame: f });
      if (a.op === 1) this.sendArp(d, ifName, 2, a.sha, a.spa, a.sha);
      return;
    }
    if (d.arp.has(a.spa) && sameNet) this.learnArp(d, a.spa, a.sha, ifName);
    // Proxy ARP (enabled by default on IOS router interfaces).
    if (a.op === 1 && a.tpa !== a.spa && d.ios && this.routingEnabled(d) && d.ios.interfaces.get(ifName)?.proxyArp && sameNet) {
      const r = this.resolve(d, a.tpa);
      if (r && r.iface !== ifName) {
        this.learnArp(d, a.spa, a.sha, ifName);
        this.record({ device: d.doc.id, kind: 'deliver', proto: 'ARP', info: `Proxy ARP for ${ipToString(a.tpa)}`, frame: f });
        return this.sendArp(d, ifName, 2, a.sha, a.spa, a.sha, a.tpa);
      }
    }
    this.drop(d, f, dropReason('arp_not_for_me'));
  }

  private learnArp(d: RtDevice, ip: number, mac: string, iface: string): void {
    d.arp.set(ip, { mac, iface, at: this.now });
    const pending = d.pendingArp.get(ip);
    if (pending) {
      d.pendingArp.delete(ip);
      for (const q of pending.packets) this.sendFrame(d, q.iface, mac, q.pkt);
    }
  }

  private sendArp(d: RtDevice, ifName: string, op: 1 | 2, dstMac: string, tpa: number, tha: string, spaOverride?: number): void {
    const me = this.l3If(d, ifName)!;
    const f: Frame = { src: me.mac, dst: dstMac, type: 'arp', arp: { op, sha: me.mac, spa: spaOverride ?? me.ip, tha, tpa }, hops: 0 };
    this.ifTransmit(d, ifName, f);
  }

  gratuitousArp(d: RtDevice, ifName: string): void {
    const me = this.l3If(d, ifName);
    if (!me || !this.ifUp(d, ifName)) return;
    const media = d.ports.get(ifName.split('.')[0]!)?.spec.media;
    if (media !== 'copper' && media !== 'fiber' && !ifName.startsWith('Vlan')) return;
    const f: Frame = { src: me.mac, dst: BROADCAST_MAC, type: 'arp', arp: { op: 1, sha: me.mac, spa: me.ip, tha: '000000000000', tpa: me.ip }, hops: 0 };
    this.ifTransmit(d, ifName, f);
  }

  arpLookup(d: RtDevice, ip: number): ArpEntry | undefined {
    const e = d.arp.get(ip);
    if (!e) return undefined;
    if (this.now - e.at > (d.host ? ARP_AGING_HOST : ARP_AGING_IOS)) {
      d.arp.delete(ip);
      return undefined;
    }
    return e;
  }

  /** Sends a logical-interface frame to the right physical port (subinterface tag, SVI fabric, serial). */
  private ifTransmit(d: RtDevice, ifName: string, f: Frame): void {
    if (ifName.startsWith('Vlan')) return this.switchForward(d, Number(ifName.slice(4)), f);
    const [port, sub] = ifName.split('.');
    if (sub && d.ios) {
      const dq = d.ios.interfaces.get(ifName)?.dot1q;
      if (!dq) return this.drop(d, f, dropReason('no_encapsulation', { iface: ifName }));
      f = { ...f, ...(dq.native ? {} : { tag: dq.vlan }) };
    }
    this.transmit(d, port!, f);
  }

  /** @internal used by application services (DHCP broadcasts). */
  sendFrame(d: RtDevice, ifName: string, dstMac: string, pkt: Ipv4Pkt): void {
    const me = this.l3If(d, ifName);
    const f: Frame = { src: me?.mac ?? this.ifMac(d, ifName), dst: dstMac, type: 'ipv4', ip: pkt, hops: 0 };
    this.ifTransmit(d, ifName, f);
  }

  /** IP output on an interface toward an L2 next hop (ARP as needed). */
  private l3Output(d: RtDevice, ifName: string, nextHop: number, pkt: Ipv4Pkt): void {
    const port = d.ports.get(ifName.split('.')[0]!);
    if (port?.spec.media === 'serial') {
      const f: Frame = { src: '', dst: '', type: 'ipv4', ip: pkt, hdlc: true, hops: 0 };
      return this.transmit(d, ifName, f);
    }
    const me = this.l3If(d, ifName);
    if (!me) return this.drop(d, { src: '', dst: '', type: 'ipv4', ip: pkt, hops: 0 }, dropReason('no_ip', { iface: ifName }));
    if (pkt.dst === BROADCAST_IP || pkt.dst === broadcastOf(me.ip, me.mask)) return this.sendFrame(d, ifName, BROADCAST_MAC, pkt);
    const e = this.arpLookup(d, nextHop);
    if (e) return this.sendFrame(d, ifName, e.mac, pkt);
    const pend = d.pendingArp.get(nextHop);
    const fresh = pend && this.now - pend.since < 2000;
    if (d.host) {
      // End hosts queue the datagram while ARP resolves.
      if (fresh) pend.packets.push({ iface: ifName, pkt });
      else d.pendingArp.set(nextHop, { since: this.now, packets: [{ iface: ifName, pkt }] });
    } else {
      // IOS drops the datagram that triggered ARP (the classic ".!!!!").
      this.drop(d, { src: me.mac, dst: '', type: 'ipv4', ip: pkt, hops: 0 }, dropReason('arp_incomplete', { ip: ipToString(nextHop) }));
      if (!fresh) d.pendingArp.set(nextHop, { since: this.now, packets: [] });
    }
    if (!fresh) this.sendArp(d, ifName, 1, BROADCAST_MAC, nextHop, '000000000000');
  }

  private forward(d: RtDevice, inIf: string, p: Ipv4Pkt, f: Frame): void {
    if (p.ttl <= 1) {
      this.drop(d, f, dropReason('ttl_expired'));
      return this.icmpError(d, p, 11, 0);
    }
    const r = this.resolve(d, p.dst);
    if (!r) {
      this.drop(d, f, dropReason('no_route', { dst: ipToString(p.dst) }));
      return this.icmpError(d, p, 3, 0);
    }
    const out = d.ios!.interfaces.get(r.iface);
    const translated = natOutbound(this, d, inIf, r.iface, p);
    if (!translated) return this.drop(d, f, dropReason('nat_exhausted'));
    p = translated;
    if (out?.aclOut && !this.aclPermits(d, out.aclOut, p)) {
      this.drop(d, f, dropReason('acl_out', { acl: out.aclOut, iface: r.iface }));
      return this.icmpError(d, p, 3, 13);
    }
    this.record({ device: d.doc.id, kind: 'deliver', proto: protoOf(f), info: `routed via ${r.iface} next-hop ${ipToString(r.nextHop)}`, frame: f });
    this.l3Output(d, r.iface, r.nextHop, { ...p, ttl: p.ttl - 1 });
  }

  aclPermits(d: RtDevice, name: string, p: Ipv4Pkt, count = true): boolean {
    const acl = d.ios?.acls.get(name);
    if (!acl) return true; // IOS: an undefined ACL permits everything
    for (const e of acl) if (this.aclMatch(d, name, e, p)) {
      if (count) e.matches++;
      return e.action === 'permit';
    }
    return false;
  }

  private aclMatch(d: RtDevice, name: string, e: AclEntry, p: Ipv4Pkt): boolean {
    if (!wildcardMatch(p.src, e.src.ip, e.src.wildcard)) return false;
    const type = d.ios?.aclTypes.get(name);
    if (type === 'standard' || (!type && Number(name) >= 1 && Number(name) <= 99)) return true;
    if (e.proto !== 'ip' && e.proto !== p.proto) return false;
    if (e.dst && !wildcardMatch(p.dst, e.dst.ip, e.dst.wildcard)) return false;
    if (e.dstPort !== undefined && (p.udp ?? p.tcp)?.dport !== e.dstPort) return false;
    return true;
  }

  private localDeliver(d: RtDevice, inIf: string, p: Ipv4Pkt, f: Frame): void {
    this.record({ device: d.doc.id, kind: 'deliver', proto: protoOf(f), info: describeFrame(f), frame: f });
    if (p.proto === 'icmp') {
      const ic = p.icmp!;
      if (ic.type === 8) {
        const me = this.l3If(d, inIf);
        const src = p.dst === BROADCAST_IP || !this.l3Ifs(d).some((i) => i.ip === p.dst) ? me?.ip : p.dst;
        if (src === undefined) return;
        this.originate(d, { src, dst: p.src, ttl: this.defaultTtl(d), proto: 'icmp', id: this.ipId++, icmp: { type: 0, code: 0, ident: ic.ident, seq: ic.seq } });
        return;
      }
      if (ic.type === 0) return this.wake(`${d.doc.id}|i|${ic.ident}|${ic.seq}`, { kind: 'reply', from: p.src, rtt: 0, ttl: p.ttl });
      if ((ic.type === 3 || ic.type === 11) && ic.quote) {
        const q = ic.quote;
        const key = q.proto === 'icmp' ? `${d.doc.id}|i|${q.ident}|${q.seq}` : `${d.doc.id}|${q.proto === 'tcp' ? 't' : 'u'}|${q.sport}`;
        if (ic.type === 11) return this.wake(key, { kind: 'ttl-exceeded', from: p.src, rtt: 0 });
        if (ic.code === 3) return this.wake(key, { kind: 'port-unreachable', from: p.src, rtt: 0 });
        return this.wake(key, { kind: 'unreachable', from: p.src, code: ic.code });
      }
      return;
    }
    if (p.proto === 'udp') {
      const u = p.udp!;
      const key = `${d.doc.id}|u|${u.dport}`;
      if (u.data && this.waiters.has(key)) {
        if (u.data.app === 'dhcp' && u.data.dhcp.chaddr !== d.ports.get(inIf.split('.')[0]!)?.mac) return;
        return this.wake(key, { kind: 'data', from: p.src, rtt: 0, data: u.data });
      }
      if (this.apps.udp(d, inIf, p)) return;
      // No UDP service is listening on this port: answer port-unreachable (traceroute relies on it).
      if (p.dst !== BROADCAST_IP) this.icmpError(d, p, 3, 3);
      return;
    }
    if (p.proto === 'tcp') {
      const t = p.tcp!;
      const key = `${d.doc.id}|t|${t.dport}`;
      if (this.waiters.has(key)) {
        if (t.flags === 'SYN-ACK') return this.wake(key, { kind: 'synack', from: p.src, rtt: 0 });
        if (t.flags === 'FIN-ACK') return this.wake(key, { kind: 'closed' });
        if (t.flags === 'RST') return this.wake(key, { kind: 'reset', from: p.src, rtt: 0 });
        if (t.data) return this.wake(key, { kind: 'data', from: p.src, rtt: 0, data: t.data });
        return;
      }
      this.apps.tcp(d, p);
      return;
    }
    if (p.proto === 'ospf') return;
  }

  private wake(key: string, o: EchoOutcome): void {
    const w = this.waiters.get(key);
    if (w) {
      this.waiters.delete(key);
      w(o);
    }
  }

  nextIpId(): number {
    return this.ipId++;
  }

  defaultTtl(d: RtDevice): number {
    return d.host ? 128 : 255;
  }

  private icmpError(d: RtDevice, orig: Ipv4Pkt, type: number, code: number): void {
    if (orig.proto === 'icmp' && orig.icmp!.type !== 8 && orig.icmp!.type !== 0) return; // never answer an error with an error
    if (orig.dst === BROADCAST_IP) return;
    const r = this.resolve(d, orig.src);
    if (!r) return;
    const src = this.l3If(d, r.iface)?.ip;
    if (src === undefined) return;
    const quote: IpQuote = { src: orig.src, dst: orig.dst, proto: orig.proto };
    if (orig.icmp) {
      quote.ident = orig.icmp.ident;
      quote.seq = orig.icmp.seq;
    }
    const l4 = orig.udp ?? orig.tcp;
    if (l4) {
      quote.sport = l4.sport;
      quote.dport = l4.dport;
    }
    const icmp: IcmpPkt = { type, code, ident: 0, seq: 0, quote };
    this.originate(d, { src, dst: orig.src, ttl: 255, proto: 'icmp', id: this.ipId++, icmp });
  }

  /** Sends a locally generated datagram. Returns false when there is no route. */
  originate(d: RtDevice, pkt: Ipv4Pkt, viaIf?: string): boolean {
    let r: { iface: string; nextHop: number } | null;
    if (viaIf) r = this.ifUp(d, viaIf) ? { iface: viaIf, nextHop: pkt.dst } : null;
    else r = this.resolve(d, pkt.dst);
    if (!r) {
      this.record({ device: d.doc.id, kind: 'drop', proto: pkt.proto.toUpperCase(), info: `${ipToString(pkt.src)} > ${ipToString(pkt.dst)}`, reason: dropReason(d.host ? 'no_gateway' : 'no_route', { dst: ipToString(pkt.dst) }), frame: { src: '', dst: '', type: 'ipv4', ip: pkt, hops: 0 } });
      return false;
    }
    if (pkt.src === 0) pkt.src = this.l3If(d, r.iface)?.ip ?? 0;
    this.l3Output(d, r.iface, r.nextHop, pkt);
    return true;
  }

  // ===========================================================================================
  // Probes used by ping / traceroute / grading
  // ===========================================================================================

  /** Sends one ICMP echo and runs the simulation until the answer or the timeout. */
  echo(devId: string, dst: number, opts: { ttl?: number; timeout?: number; src?: number } = {}): EchoOutcome {
    const d = this.dev(devId);
    if (d.doc.powered && dst !== BROADCAST_IP && this.l3Ifs(d).some((i) => i.ip === dst && this.ifUp(d, i.name))) {
      return { kind: 'reply', from: dst, rtt: 0, ttl: opts.ttl ?? this.defaultTtl(d) }; // loopback
    }
    const ident = this.ident++ & 0xffff;
    const seq = 0;
    const key = `${devId}|i|${ident}|${seq}`;
    return this.probe(d, key, opts.timeout ?? 2000, () =>
      this.originate(d, { src: opts.src ?? 0, dst, ttl: opts.ttl ?? this.defaultTtl(d), proto: 'icmp', id: this.ipId++, icmp: { type: 8, code: 0, ident, seq } }),
    );
  }

  /** IOS-style UDP traceroute probe. */
  udpProbe(devId: string, dst: number, ttl: number, timeout = 3000): EchoOutcome {
    const d = this.dev(devId);
    const sport = this.sport++;
    if (this.sport > 65000) this.sport = 49152;
    return this.probe(d, `${devId}|u|${sport}`, timeout, () =>
      this.originate(d, { src: 0, dst, ttl, proto: 'udp', id: this.ipId++, udp: { sport, dport: 33434 + ttl } }),
    );
  }

  private probe(d: RtDevice, key: string, timeout: number, send: () => boolean): EchoOutcome {
    if (!d.doc.powered) return { kind: 'no-route' };
    let outcome: EchoOutcome | null = null;
    const start = this.now;
    this.waiters.set(key, (o) => (outcome = o));
    if (!send()) {
      this.waiters.delete(key);
      return { kind: 'no-route' };
    }
    this.runUntil(start + timeout, () => outcome !== null);
    this.waiters.delete(key);
    const o = outcome as EchoOutcome | null;
    if (!o) return { kind: 'timeout' };
    if ('rtt' in o) return { ...o, rtt: this.now - start };
    return o;
  }

  /** Simulation mode: injects an ICMP echo without running the clock. Resolves via callback when answered. */
  injectEcho(devId: string, dst: number, onResult: (o: EchoOutcome) => void): boolean {
    const d = this.dev(devId);
    const ident = this.ident++ & 0xffff;
    this.waiters.set(`${devId}|i|${ident}|0`, onResult);
    return this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'icmp', id: this.ipId++, icmp: { type: 8, code: 0, ident, seq: 0 } });
  }

  injectPdu(devId: string, dst: number, protocol: 'icmp' | 'tcp' | 'udp', dstPort: number, onResult: (o: EchoOutcome) => void): { sent: boolean; sourcePort?: number } {
    if (protocol === 'icmp') return { sent: this.injectEcho(devId, dst, onResult) };
    const d = this.dev(devId);
    const sport = this.allocPort();
    const key = `${devId}|${protocol === 'tcp' ? 't' : 'u'}|${sport}`;
    this.waiters.set(key, onResult);
    if (protocol === 'udp') {
      const data: AppData | undefined = dstPort === 53
        ? { app: 'dns', dns: { id: this.ipId & 0xffff, qname: 'tpacket.invalid' } }
        : undefined;
      return { sent: this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'udp', id: this.ipId++, udp: { sport, dport: dstPort, ...(data ? { data } : {}) } }), sourcePort: sport };
    }
    return { sent: this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'tcp', id: this.ipId++, tcp: { sport, dport: dstPort, flags: 'SYN', seq: 1000, ack: 0 } }), sourcePort: sport };
  }

  /** Lets protocols converge (STP timers, gratuitous ARPs) — used before grading and by "Fast Forward Time". */
  converge(ms = 2 * FORWARD_DELAY + 1000): void {
    this.advance(ms);
  }

  // ===========================================================================================
  // Application clients (UDP / TCP / DHCP / DNS)
  // ===========================================================================================

  private allocPort(): number {
    const p = this.sport++;
    if (this.sport > 65000) this.sport = 49152;
    return p;
  }

  /** Sends a UDP request and waits for the application reply. */
  udpRequest(devId: string, dst: number, dport: number, data: AppData, timeout = 3000, tries = 3): EchoOutcome {
    const d = this.dev(devId);
    const sport = this.allocPort();
    let o: EchoOutcome = { kind: 'timeout' };
    // Clients retransmit: the first datagram may be dropped by a router resolving ARP.
    for (let i = 0; i < tries && (o.kind === 'timeout'); i++) {
      o = this.probe(d, `${devId}|u|${sport}`, timeout, () => this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'udp', id: this.ipId++, udp: { sport, dport, data } }));
    }
    return o;
  }

  /** TCP handshake, one request/response exchange, and an orderly FIN close. */
  tcpTransaction(devId: string, dst: number, dport: number, data: AppData, timeout = 3000): EchoOutcome {
    const d = this.dev(devId);
    const sport = this.allocPort();
    const key = `${devId}|t|${sport}`;
    const seg = (flags: TcpFlags, seq: number, ack: number, payload?: AppData) => () =>
      this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'tcp', id: this.ipId++, tcp: { sport, dport, flags, seq, ack, ...(payload ? { data: payload } : {}) } });
    const retry = (send: () => boolean): EchoOutcome => {
      let outcome: EchoOutcome = { kind: 'timeout' };
      for (let i = 0; i < 3 && outcome.kind === 'timeout'; i++) outcome = this.probe(d, key, timeout, send);
      return outcome;
    };
    const hs = retry(seg('SYN', 1000, 0));
    if (hs.kind !== 'synack') return hs;
    this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'tcp', id: this.ipId++, tcp: { sport, dport, flags: 'ACK', seq: 1001, ack: 5001 } });
    const response = retry(seg('PSH-ACK', 1001, 5001, data));
    if (response.kind !== 'data') return response;
    const close = retry(seg('FIN', 1002, 5002));
    if (close.kind !== 'closed') return close;
    this.originate(d, { src: 0, dst, ttl: this.defaultTtl(d), proto: 'tcp', id: this.ipId++, tcp: { sport, dport, flags: 'ACK', seq: 1003, ack: 5003 } });
    return response;
  }

  /** `ipconfig /renew`: DHCP DISCOVER/OFFER/REQUEST/ACK, then APIPA when no server answers. */
  dhcpRenew(devId: string): { ok: boolean; ip?: string } {
    const d = this.dev(devId);
    const h = d.host;
    if (!h) return { ok: false };
    const ifn = this.hostIf(d);
    const mac = d.ports.get(ifn)!.mac;
    h.ipMode = 'dhcp';
    if (!this.portStatus(devId, ifn).proto) return { ok: false };
    const xid = (this.ipId * 7919) & 0xffffffff;
    const send = (msg: DhcpMsg) => () => {
      this.sendFrame(d, ifn, BROADCAST_MAC, { src: 0, dst: BROADCAST_IP, ttl: 128, proto: 'udp', id: this.ipId++, udp: { sport: 68, dport: 67, data: { app: 'dhcp', dhcp: msg } } });
      return true;
    };
    const base: DhcpMsg = { op: 'DISCOVER', xid, chaddr: mac, ciaddr: 0, yiaddr: 0, giaddr: 0 };
    let offer: EchoOutcome = { kind: 'timeout' };
    for (let i = 0; i < 3 && offer.kind === 'timeout'; i++) offer = this.probe(d, `${devId}|u|68`, 4000, send(base));
    const finish = (ip: string, mask: string, gw: string, dns: string, server?: number) => {
      h.ip = ip;
      h.mask = mask;
      h.gateway = gw;
      h.dns = dns;
      if (server === undefined) delete d.dhcpServer;
      else d.dhcpServer = server;
      d.arp.clear();
      this.refresh();
      this.gratuitousArp(d, ifn);
    };
    if (offer.kind === 'data' && offer.data.app === 'dhcp' && offer.data.dhcp.op === 'OFFER') {
      const o = offer.data.dhcp;
      let ack: EchoOutcome = { kind: 'timeout' };
      for (let i = 0; i < 3 && ack.kind === 'timeout'; i++) ack = this.probe(d, `${devId}|u|68`, 4000, send({ ...base, op: 'REQUEST', yiaddr: o.yiaddr, ...(o.server !== undefined ? { server: o.server } : {}) }));
      if (ack.kind === 'data' && ack.data.app === 'dhcp' && ack.data.dhcp.op === 'ACK') {
        const a = ack.data.dhcp;
        finish(ipToString(a.yiaddr), ipToString(a.mask ?? 0), a.router !== undefined ? ipToString(a.router) : '', a.dns !== undefined ? ipToString(a.dns) : '', a.server);
        return { ok: true, ip: ipToString(a.yiaddr) };
      }
    }
    // APIPA (169.254.0.0/16), deterministic from the MAC address.
    const n = parseInt(mac.slice(8), 16);
    finish(`169.254.${(n >> 8) % 254 + 1}.${(n & 255) % 254 + 1}`, '255.255.0.0', '', '');
    return { ok: false };
  }

  ipv6Renew(devId: string): { ok: boolean; ipv6?: string; gateway?: string } {
    const d = this.dev(devId);
    const host = d.host;
    if (!host || (host.ipv6Mode !== 'slaac' && host.ipv6Mode !== 'dhcpv6')) return { ok: false };
    const ifName = this.hostIf(d);
    const iface = this.l3Ifs6(d).find((i) => i.name === ifName);
    if (!iface || !this.portStatus(devId, ifName).proto) return { ok: false };
    const ident = this.ident++ & 0xffff;
    const ra = this.probe(d, `${devId}|ra6|${ident}`, 2000, () => {
      const request: Ipv6Pkt = { src: iface.ll, dst: ALL_ROUTERS6, hop: 255, icmp6: { type: 133, code: 0, ident } };
      this.ifTransmit(d, ifName, { src: iface.mac, dst: multicastMac6(ALL_ROUTERS6), type: 'ipv6', ip6: request, hops: 0 });
      return true;
    });
    if (ra.kind !== 'reply') return { ok: false };
    if (host.ipv6Mode === 'slaac') return host.ipv6 ? { ok: true, ipv6: host.ipv6, ...(host.ipv6Gateway ? { gateway: host.ipv6Gateway } : {}) } : { ok: false };

    const xid = this.ipId++ & 0xffffff;
    const exchange = (msg: Dhcp6Msg): EchoOutcome => this.probe(d, `${devId}|u6|546`, 2000, () => {
      this.send6(d, ifName, DHCP_SERVERS6, { src: iface.ll, dst: DHCP_SERVERS6, hop: 1, udp: { sport: 546, dport: 547, data: { app: 'dhcp6', dhcp6: msg } } });
      return true;
    });
    const clientMac = iface.mac;
    const advertise = exchange({ op: 'SOLICIT', xid, clientMac });
    if (advertise.kind !== 'data' || advertise.data.app !== 'dhcp6' || advertise.data.dhcp6.op !== 'ADVERTISE') return { ok: false };
    const offer = advertise.data.dhcp6;
    if (offer.address === undefined || !offer.prefix) return { ok: false };
    const reply = exchange({ op: 'REQUEST', xid, clientMac, address: offer.address });
    if (reply.kind !== 'data' || reply.data.app !== 'dhcp6' || reply.data.dhcp6.op !== 'REPLY' || reply.data.dhcp6.address === undefined || !reply.data.dhcp6.prefix) return { ok: false };
    const leaseAddress = reply.data.dhcp6.address;
    const leasePrefix = reply.data.dhcp6.prefix;
    if (leaseAddress === undefined || !leasePrefix) return { ok: false };
    host.ipv6 = `${ip6ToString(leaseAddress)}/${leasePrefix.len}`;
    this.refresh();
    return { ok: true, ipv6: host.ipv6, ...(host.ipv6Gateway ? { gateway: host.ipv6Gateway } : {}) };
  }

  /** Name resolution through the configured DNS server (or a literal address). */
  resolveName(devId: string, name: string): { ip?: number; error?: 'no_dns' | 'timeout' | 'nxdomain' } {
    const literal = parseIp(name);
    if (literal !== null) return { ip: literal };
    const d = this.dev(devId);
    const server = parseIp(d.host?.dns ?? '');
    if (server === null) return { error: 'no_dns' };
    const r = this.udpRequest(devId, server, 53, { app: 'dns', dns: { id: this.ipId & 0xffff, qname: name.toLowerCase() } });
    if (r.kind !== 'data' || r.data.app !== 'dns') return { error: 'timeout' };
    return r.data.dns.answer !== undefined ? { ip: r.data.dns.answer } : { error: 'nxdomain' };
  }

  // ===========================================================================================
  // IPv6 (static addressing, link-local, Neighbor Discovery, ICMPv6, static routing)
  // ===========================================================================================

  l3Ifs6(d: RtDevice): L3If6[] {
    if (d.host) {
      const c = parseCidr6(d.host.ipv6 ?? '');
      const name = this.hostIf(d);
      const mac = d.ports.get(name)!.mac;
      const addrs = c && !isLinkLocal(c.ip) ? [{ ip: c.ip, len: c.len }] : [];
      if (!addrs.length && d.host.ipv6Mode !== 'slaac' && d.host.ipv6Mode !== 'dhcpv6') return [];
      return [{ name, mac, ll: linkLocal(mac), addrs }];
    }
    if (!d.ios) return [];
    const out: L3If6[] = [];
    for (const cfg of d.ios.interfaces.values()) {
      if (cfg.switchport || (!cfg.ipv6.length && !cfg.ipv6Enable)) continue;
      const mac = this.ifMac(d, cfg.name);
      out.push({ name: cfg.name, mac, ll: linkLocal(mac), addrs: cfg.ipv6 });
    }
    return out;
  }

  routes6(d: RtDevice): Route6[] {
    const out: Route6[] = [];
    if (!d.doc.powered) return out;
    for (const i of this.l3Ifs6(d)) {
      if (!this.ifUp(d, i.name)) continue;
      for (const a of i.addrs) {
        out.push({ type: 'C', prefix: network6(a.ip, a.len), len: a.len, ad: 0, iface: i.name });
        if (d.ios) out.push({ type: 'L', prefix: a.ip, len: 128, ad: 0, iface: i.name });
      }
    }
    if (d.host) {
      const gw = parseIp6(d.host.ipv6Gateway ?? '');
      const i = this.l3Ifs6(d)[0];
      if (gw !== null && i && this.ifUp(d, i.name)) out.push({ type: 'S', prefix: 0n, len: 0, ad: 1, nextHop: gw, iface: i.name });
      return out;
    }
    if (!d.ios!.ipv6Routing) return out;
    for (const r of d.ios!.ipv6Routes) {
      let ok = false;
      let iface = r.iface;
      if (iface) ok = this.ifUp(d, iface);
      else if (r.nextHop !== undefined) {
        const via = this.lookup6(out, r.nextHop);
        ok = !!via;
        iface = via?.iface;
      }
      if (ok) out.push({ type: 'S', prefix: r.prefix, len: r.len, ad: r.distance, ...(r.nextHop !== undefined ? { nextHop: r.nextHop } : {}), ...(iface ? { iface } : {}) });
    }
    out.push(...(this.dynamic().routes6.get(d.doc.id) ?? []));
    return out;
  }

  private lookup6(routes: Route6[], dst: bigint): Route6 | undefined {
    let best: Route6 | undefined;
    for (const r of routes) if (network6(dst, r.len) === r.prefix && (!best || r.len > best.len || (r.len === best.len && r.ad < best.ad))) best = r;
    return best;
  }

  resolve6(d: RtDevice, dst: bigint): { iface: string; nextHop: bigint } | null {
    const r = this.lookup6(this.routes6(d), dst);
    if (!r?.iface) return null;
    return { iface: r.iface, nextHop: r.nextHop ?? dst };
  }

  private isLocal6(d: RtDevice, ip: bigint): boolean {
    return this.l3Ifs6(d).some((i) => this.ifUp(d, i.name) && (i.ll === ip || i.addrs.some((a) => a.ip === ip)));
  }

  private send6(d: RtDevice, ifName: string, nextHop: bigint, pkt: Ipv6Pkt): void {
    const me = this.l3Ifs6(d).find((i) => i.name === ifName);
    if (!me) return;
    const port = d.ports.get(ifName.split('.')[0]!);
    if (port?.spec.media === 'serial') return this.transmit(d, ifName, { src: '', dst: '', type: 'ipv6', ip6: pkt, hdlc: true, hops: 0 });
    if (isMulticast6(nextHop)) return this.ifTransmit(d, ifName, { src: me.mac, dst: multicastMac6(nextHop), type: 'ipv6', ip6: pkt, hops: 0 });
    const n = d.nd.get(nextHop);
    if (n) return this.ifTransmit(d, ifName, { src: me.mac, dst: n.mac, type: 'ipv6', ip6: pkt, hops: 0 });
    const pend = d.pendingNd.get(nextHop);
    const fresh = pend && this.now - pend.since < 2000;
    if (fresh) pend.packets.push({ iface: ifName, pkt });
    else d.pendingNd.set(nextHop, { since: this.now, packets: [{ iface: ifName, pkt }] });
    if (!fresh) {
      const src = me.addrs[0]?.ip ?? me.ll;
      // Neighbor Solicitation to the solicited-node multicast group (flooded by switches).
      const ns: Ipv6Pkt = { src, dst: (0xff02n << 112n) | (0x1ffn << 24n) | (nextHop & 0xffffffn), hop: 255, icmp6: { type: 135, code: 0, target: nextHop, lladdr: me.mac } };
      this.ifTransmit(d, ifName, { src: me.mac, dst: BROADCAST_MAC, type: 'ipv6', ip6: ns, hops: 0 });
    }
  }

  sendOspf6Control(d: RtDevice, ifName: string, message: Ospf6ControlMessage): void {
    const iface = this.l3Ifs6(d).find((candidate) => candidate.name === ifName);
    if (!iface || !this.ifUp(d, ifName)) return;
    const dst = (0xff02n << 112n) | 0x5n;
    const pkt: Ipv6Pkt = { src: iface.ll, dst, hop: 1, ospf6: message };
    this.ifTransmit(d, ifName, { src: iface.mac, dst: multicastMac6(dst), type: 'ipv6', ip6: pkt, hops: 0 });
  }

  originate6(d: RtDevice, pkt: Ipv6Pkt): boolean {
    const r = this.resolve6(d, pkt.dst);
    if (!r) return false;
    if (pkt.src === 0n) {
      const i = this.l3Ifs6(d).find((x) => x.name === r.iface)!;
      pkt.src = isLinkLocal(pkt.dst) ? i.ll : (i.addrs[0]?.ip ?? i.ll);
    }
    this.send6(d, r.iface, r.nextHop, pkt);
    return true;
  }

  private receive6(d: RtDevice, ifName: string, f: Frame): void {
    const p = f.ip6!;
    const me = this.l3Ifs6(d).find((i) => i.name === ifName);
    if (!me) return this.drop(d, f, dropReason('no_ipv6', { iface: ifName }));
    if (p.ospf6) {
      if (!d.ios?.ipv6Routing || !d.ios.ospf6) return this.drop(d, f, dropReason('not_for_me'));
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'OSPFv3', info: describeFrame(f), frame: f });
      return;
    }
    if (p.udp) {
      if (p.src !== 0n) d.nd.set(p.src, { mac: f.src, iface: ifName, at: this.now });
      if (d.ios && p.udp.dport === 547 && p.udp.data?.app === 'dhcp6' && isMulticast6(p.dst)) {
        return this.receiveDhcp6(d, ifName, p, p.udp.data.dhcp6);
      }
      if (this.isLocal6(d, p.dst)) {
        this.record({ device: d.doc.id, kind: 'deliver', proto: 'UDPv6', info: describeFrame(f), frame: f });
        if (d.host && p.udp.data?.app === 'dhcp6') return this.wake(`${d.doc.id}|u6|${p.udp.dport}`, { kind: 'data', from: 0, rtt: 0, data: p.udp.data });
        return;
      }
      if (!d.ios?.ipv6Routing) return this.drop(d, f, dropReason('not_for_me'));
      const r = this.resolve6(d, p.dst);
      if (!r) return this.drop(d, f, dropReason('no_route', { dst: ip6s(p.dst) }));
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'UDPv6', info: `routed via ${r.iface}`, frame: f });
      return this.send6(d, r.iface, r.nextHop, { ...p, hop: p.hop - 1 });
    }
    const ic = p.icmp6;
    if (!ic) return this.drop(d, f, dropReason('invalid_packet'));
    if (ic.type === 135) {
      if (p.src !== 0n) d.nd.set(p.src, { mac: ic.lladdr ?? f.src, iface: ifName, at: this.now });
      this.flushNd(d, p.src);
      if (ic.target !== me.ll && !me.addrs.some((a) => a.ip === ic.target)) return this.drop(d, f, dropReason('arp_not_for_me'));
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'NDP', info: describeFrame(f), frame: f });
      const na: Ipv6Pkt = { src: ic.target!, dst: p.src, hop: 255, icmp6: { type: 136, code: 0, target: ic.target!, lladdr: me.mac } };
      return this.ifTransmit(d, ifName, { src: me.mac, dst: ic.lladdr ?? BROADCAST_MAC, type: 'ipv6', ip6: na, hops: 0 });
    }
    if (ic.type === 133) {
      if (p.src !== 0n) d.nd.set(p.src, { mac: f.src, iface: ifName, at: this.now });
      const prefix = me.addrs.find((a) => !isLinkLocal(a.ip));
      if (!d.ios?.ipv6Routing || !prefix) return this.drop(d, f, dropReason('no_ipv6', { iface: ifName }));
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'NDP', info: describeFrame(f), frame: f });
      const ra: Ipv6Pkt = {
        src: me.ll,
        dst: p.src,
        hop: 255,
        icmp6: { type: 134, code: 0, ident: ic.ident, prefix: { network: network6(prefix.ip, prefix.len), len: prefix.len }, managed: !!d.ios.interfaces.get(ifName)?.ipv6Managed },
      };
      return this.ifTransmit(d, ifName, { src: me.mac, dst: f.src, type: 'ipv6', ip6: ra, hops: 0 });
    }
    if (ic.type === 134) {
      if (d.host) {
        d.nd.set(p.src, { mac: f.src, iface: ifName, at: this.now });
        if (isLinkLocal(p.src)) d.host.ipv6Gateway = ip6ToString(p.src);
        if (d.host.ipv6Mode === 'slaac' && ic.prefix) {
          const hostBits = (1n << BigInt(128 - ic.prefix.len)) - 1n;
          const address = network6(ic.prefix.network, ic.prefix.len) | (me.ll & hostBits);
          d.host.ipv6 = `${ip6ToString(address)}/${ic.prefix.len}`;
        }
        this.refresh();
        this.wake(`${d.doc.id}|ra6|${ic.ident}`, { kind: 'reply', from: 0, rtt: 0, ttl: p.hop });
      }
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'NDP', info: describeFrame(f), frame: f });
      return;
    }
    if (ic.type === 136) {
      if (ic.target !== undefined && ic.lladdr) d.nd.set(ic.target, { mac: ic.lladdr, iface: ifName, at: this.now });
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'NDP', info: describeFrame(f), frame: f });
      return this.flushNd(d, ic.target!);
    }
    if (this.isLocal6(d, p.dst)) {
      this.record({ device: d.doc.id, kind: 'deliver', proto: 'ICMPv6', info: describeFrame(f), frame: f });
      if (ic.type === 128) {
        this.originate6(d, { src: p.dst, dst: p.src, hop: 64, icmp6: { type: 129, code: 0, ident: ic.ident!, seq: ic.seq! } });
        return;
      }
      if (ic.type === 129) return this.wake(`${d.doc.id}|i6|${ic.ident}|${ic.seq}`, { kind: 'reply', from: 0, rtt: 0, ttl: p.hop });
      if ((ic.type === 1 || ic.type === 3) && ic.quote) {
        const key = `${d.doc.id}|i6|${ic.quote.ident}|${ic.quote.seq}`;
        return this.wake(key, ic.type === 3 ? { kind: 'ttl-exceeded', from: 0, rtt: 0 } : { kind: 'unreachable', from: 0, code: ic.code });
      }
      return;
    }
    if (!d.ios?.ipv6Routing) return this.drop(d, f, dropReason('not_for_me'));
    const err = (type: number, code: number) => {
      if (ic.type !== 128) return;
      this.originate6(d, { src: 0n, dst: p.src, hop: 64, icmp6: { type, code, quote: { ident: ic.ident!, seq: ic.seq! } } });
    };
    if (p.hop <= 1) {
      this.drop(d, f, dropReason('ttl_expired'));
      return err(3, 0);
    }
    const r = this.resolve6(d, p.dst);
    if (!r) {
      this.drop(d, f, dropReason('no_route', { dst: ip6s(p.dst) }));
      return err(1, 0);
    }
    this.record({ device: d.doc.id, kind: 'deliver', proto: 'ICMPv6', info: `routed via ${r.iface}`, frame: f });
    this.send6(d, r.iface, r.nextHop, { ...p, hop: p.hop - 1 });
  }

  private receiveDhcp6(d: RtDevice, ifName: string, p: Ipv6Pkt, msg: Dhcp6Msg): void {
    const cfg = d.ios?.interfaces.get(ifName);
    const pool = cfg?.dhcp6Pool ? d.ios?.dhcp6Pools.get(cfg.dhcp6Pool) : undefined;
    const prefix = pool?.prefix;
    const me = this.l3Ifs6(d).find((i) => i.name === ifName);
    if (!prefix || !me) return this.drop(d, { src: '', dst: '', type: 'ipv6', ip6: p, hops: 0 }, dropReason('no_dhcp_pool'));
    let address: bigint | undefined;
    if (msg.op === 'SOLICIT') {
      address = [...d.dhcp6Bindings].find(([, lease]) => lease.mac === msg.clientMac)?.[0];
      if (address === undefined) {
        const capacity = 1n << BigInt(128 - prefix.len);
        for (let offset = 1n; offset < capacity && offset < 100_000n; offset++) {
          const candidate = prefix.network | offset;
          if (!d.dhcp6Bindings.has(candidate) && !this.l3Ifs6(d).some((i) => i.addrs.some((a) => a.ip === candidate))) {
            address = candidate;
            d.dhcp6Bindings.set(candidate, { mac: msg.clientMac, at: this.now });
            break;
          }
        }
      }
    } else if (msg.op === 'REQUEST' && msg.address !== undefined && d.dhcp6Bindings.get(msg.address)?.mac === msg.clientMac) {
      address = msg.address;
      d.dhcp6Bindings.set(address, { mac: msg.clientMac, at: this.now });
    }
    if (address === undefined) return this.drop(d, { src: '', dst: '', type: 'ipv6', ip6: p, hops: 0 }, dropReason('dhcp_exhausted'));
    const reply: Dhcp6Msg = { op: msg.op === 'SOLICIT' ? 'ADVERTISE' : 'REPLY', xid: msg.xid, clientMac: msg.clientMac, address, prefix, ...(pool.dns !== undefined ? { dns: pool.dns } : {}) };
    this.send6(d, ifName, p.src, { src: me.ll, dst: p.src, hop: 64, udp: { sport: 547, dport: 546, data: { app: 'dhcp6', dhcp6: reply } } });
  }

  private flushNd(d: RtDevice, ip: bigint): void {
    const pend = d.pendingNd.get(ip);
    const n = d.nd.get(ip);
    if (!pend || !n) return;
    d.pendingNd.delete(ip);
    for (const q of pend.packets) this.send6(d, q.iface, ip, q.pkt);
  }

  echo6(devId: string, dst: bigint, opts: { hop?: number; timeout?: number } = {}): EchoOutcome {
    const d = this.dev(devId);
    if (d.doc.powered && this.isLocal6(d, dst)) return { kind: 'reply', from: 0, rtt: 0, ttl: 64 };
    const ident = this.ident++ & 0xffff;
    return this.probe(d, `${devId}|i6|${ident}|0`, opts.timeout ?? 2000, () =>
      this.originate6(d, { src: 0n, dst, hop: opts.hop ?? (d.host ? 128 : 64), icmp6: { type: 128, code: 0, ident, seq: 0 } }),
    );
  }
}

function ip6s(n: bigint): string {
  return ip6ToString(n);
}

function isMulticast6(ip: bigint): boolean {
  return ip >> 120n === 0xffn;
}

function multicastMac6(ip: bigint): string {
  return `3333${(ip & 0xffffffffn).toString(16).padStart(8, '0')}`;
}
