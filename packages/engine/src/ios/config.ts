import { ipToString } from '../net/ipv4';
import { ip6ToString } from '../net/ipv6';
import type { DeviceKind } from '../model/types';
import type { ModelSpec } from '../model/catalog';
import { type7Encode } from '../util/secrets';

export type SwitchportMode = 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable';

export interface IfConfig {
  name: string;
  description?: string;
  ip?: { address: number; mask: number };
  shutdown: boolean;
  /** Layer-2 switch port. False for router interfaces, SVIs and `no switchport` routed ports. */
  switchport: boolean;
  mode: SwitchportMode;
  accessVlan: number;
  nativeVlan: number;
  /** Allowed VLANs on a trunk; null means "all". */
  allowed: number[] | null;
  portfast: boolean;
  dot1q?: { vlan: number; native: boolean };
  clockRate?: number;
  speed: 'auto' | '10' | '100' | '1000';
  duplex: 'auto' | 'full' | 'half';
  helpers: number[];
  aclIn?: string;
  aclOut?: string;
  proxyArp: boolean;
  natInside?: boolean;
  natOutside?: boolean;
  /** IPv6 global/unique-local addresses. */
  ipv6: { ip: bigint; len: number }[];
  /** `ipv6 enable`: link-local only. */
  ipv6Enable: boolean;
}

export interface RipConfig {
  version?: 1 | 2;
  networks: number[];
  passive: string[];
  autoSummary: boolean;
  defaultOriginate: boolean;
}

export interface OspfConfig {
  pid: number;
  routerId?: number;
  networks: { ip: number; wildcard: number; area: number }[];
  passive: string[];
  defaultOriginate: boolean;
}

export interface DhcpPool {
  name: string;
  network?: { ip: number; mask: number };
  router?: number;
  dns?: number;
  domain?: string;
}

export interface NatConfig {
  statics: { local: number; global: number }[];
  pools: Map<string, { start: number; end: number; mask: number }>;
  dynamic: { acl: string; pool?: string; iface?: string; overload: boolean }[];
}

export interface LineConfig {
  password?: string;
  login: 'none' | 'line' | 'local';
  transport: 'all' | 'ssh' | 'telnet' | 'none';
  execTimeout?: [number, number];
  loggingSync: boolean;
}

export interface StaticRoute {
  network: number;
  mask: number;
  nextHop?: number;
  iface?: string;
  distance: number;
}

export type AclProto = 'ip' | 'icmp' | 'tcp' | 'udp';
export interface AclEntry {
  action: 'permit' | 'deny';
  proto: AclProto;
  src: { ip: number; wildcard: number };
  dst?: { ip: number; wildcard: number };
  /** Destination port for tcp/udp: `eq <port>` */
  dstPort?: number;
  /** Hit counter for `show access-lists`. */
  matches: number;
}

export interface UserAccount {
  name: string;
  privilege: number;
  secret?: string;
  password?: string;
}

export interface IosConfig {
  hostname: string;
  enableSecret?: string;
  enablePassword?: string;
  servicePasswordEncryption: boolean;
  bannerMotd?: string;
  domainName?: string;
  domainLookup: boolean;
  ipRouting: boolean;
  defaultGateway?: number;
  interfaces: Map<string, IfConfig>;
  staticRoutes: StaticRoute[];
  users: UserAccount[];
  con: LineConfig;
  vty: LineConfig;
  acls: Map<string, AclEntry[]>;
  sshVersion?: 1 | 2;
  cdpRun: boolean;
  stpPriority: Map<number, number>;
  rip?: RipConfig;
  ospf?: OspfConfig;
  dhcpPools: Map<string, DhcpPool>;
  dhcpExcluded: [number, number][];
  nat: NatConfig;
  ipv6Routing: boolean;
  ipv6Routes: { prefix: bigint; len: number; nextHop?: bigint; iface?: string; distance: number }[];
}

export function defaultLine(vty: boolean): LineConfig {
  return { login: vty ? 'line' : 'none', transport: 'all', loggingSync: false };
}

export function newInterface(name: string, kind: DeviceKind, opts: { svi?: boolean } = {}): IfConfig {
  const isSwitchPort = (kind === 'switch' || kind === 'l3switch') && !opts.svi && !name.includes('.');
  return {
    name,
    // Router interfaces and SVIs start administratively down; switch ports start up (as on real gear).
    shutdown: !isSwitchPort,
    switchport: isSwitchPort,
    mode: 'dynamic auto',
    accessVlan: 1,
    nativeVlan: 1,
    allowed: null,
    portfast: false,
    speed: 'auto',
    duplex: 'auto',
    helpers: [],
    proxyArp: true,
    ipv6: [],
    ipv6Enable: false,
  };
}

export function defaultIosConfig(spec: ModelSpec, physical: string[]): IosConfig {
  const interfaces = new Map<string, IfConfig>();
  for (const p of physical) interfaces.set(p, newInterface(p, spec.kind));
  if (spec.kind !== 'router') interfaces.set('Vlan1', newInterface('Vlan1', spec.kind, { svi: true }));
  return {
    hostname: spec.kind === 'router' ? 'Router' : 'Switch',
    servicePasswordEncryption: false,
    domainLookup: true,
    ipRouting: spec.kind === 'router',
    interfaces,
    staticRoutes: [],
    users: [],
    con: defaultLine(false),
    vty: defaultLine(true),
    acls: new Map(),
    cdpRun: true,
    stpPriority: new Map(),
    dhcpPools: new Map(),
    dhcpExcluded: [],
    nat: { statics: [], pools: new Map(), dynamic: [] },
    ipv6Routing: false,
    ipv6Routes: [],
  };
}

// ------------------------------------------------------------------------------------------
// Interface naming
// ------------------------------------------------------------------------------------------

export const IF_TYPES = ['Ethernet', 'FastEthernet', 'GigabitEthernet', 'Serial', 'Vlan', 'Loopback'] as const;

export function ifShort(name: string): string {
  return name
    .replace(/^GigabitEthernet/, 'Gig')
    .replace(/^FastEthernet/, 'Fa')
    .replace(/^Serial/, 'Se')
    .replace(/^Ethernet/, 'Eth')
    .replace(/^Loopback/, 'Lo');
}

export function ifAbbrev(name: string): string {
  return name.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Serial/, 'Se').replace(/^Ethernet/, 'Et').replace(/^Loopback/, 'Lo').replace(/^Vlan/, 'Vl');
}

/** Interface sort order as IOS displays them: physical ports in definition order, then logical. */
export function sortInterfaces(names: string[], physicalOrder: string[]): string[] {
  const idx = (n: string) => {
    const base = n.split('.')[0]!;
    const i = physicalOrder.indexOf(base);
    return i === -1 ? 10000 : i;
  };
  return [...names].sort((a, b) => {
    const d = idx(a) - idx(b);
    if (d !== 0) return d;
    if (a.startsWith('Vlan') && b.startsWith('Vlan')) return Number(a.slice(4)) - Number(b.slice(4));
    const sa = Number(a.split('.')[1] ?? -1);
    const sb = Number(b.split('.')[1] ?? -1);
    return sa - sb || a.localeCompare(b);
  });
}

// ------------------------------------------------------------------------------------------
// VLAN list helpers ("1-10,20,30-40")
// ------------------------------------------------------------------------------------------

export function parseVlanList(s: string): number[] | null {
  const out = new Set<number>();
  for (const part of s.replace(/\s+/g, '').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo < 1 || hi > 4094 || lo > hi) return null;
    for (let v = lo; v <= hi; v++) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function formatVlanList(v: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < v.length) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j]! + 1) j++;
    parts.push(j > i ? `${v[i]}-${v[j]}` : `${v[i]}`);
    i = j + 1;
  }
  return parts.join(',');
}

// ------------------------------------------------------------------------------------------
// running-config rendering. Every line emitted here MUST be accepted by the parser in
// commands.ts: projects persist this text and reload it through the CLI.
// ------------------------------------------------------------------------------------------

function wildcardText(ip: number, wc: number): string {
  if (wc === 0) return `host ${ipToString(ip)}`;
  if (wc === 0xffffffff) return 'any';
  return `${ipToString(ip)} ${ipToString(wc)}`;
}

export function aclEntryText(name: string, e: AclEntry, numbered: boolean): string {
  const head = numbered ? `access-list ${name} ` : ' ';
  const std = Number(name) >= 1 && Number(name) <= 99;
  if (std) {
    const src = e.src.wildcard === 0 ? (numbered ? `host ${ipToString(e.src.ip)}` : `host ${ipToString(e.src.ip)}`) : wildcardText(e.src.ip, e.src.wildcard);
    return `${head}${e.action} ${src}`;
  }
  let s = `${head}${e.action} ${e.proto} ${wildcardText(e.src.ip, e.src.wildcard)} ${wildcardText(e.dst!.ip, e.dst!.wildcard)}`;
  if (e.dstPort !== undefined) s += ` eq ${e.dstPort}`;
  return s;
}

function secretLine(pw: string, encrypt: boolean): string {
  return encrypt ? `7 ${type7Encode(pw)}` : pw;
}

export function renderRunningConfig(c: IosConfig, spec: ModelSpec, physicalOrder: string[]): string {
  const L: string[] = [];
  const ver = spec.ios?.version.split('(')[0] ?? '12.2';
  L.push('!', `version ${ver}`);
  L.push(c.servicePasswordEncryption ? 'service password-encryption' : 'no service password-encryption');
  L.push('!', `hostname ${c.hostname}`, '!');
  if (c.enableSecret) L.push(`enable secret 5 ${c.enableSecret}`);
  if (c.enablePassword) L.push(`enable password ${secretLine(c.enablePassword, c.servicePasswordEncryption)}`);
  if (c.enableSecret || c.enablePassword) L.push('!');
  for (const u of c.users) {
    const priv = u.privilege !== 1 ? ` privilege ${u.privilege}` : '';
    if (u.secret) L.push(`username ${u.name}${priv} secret 5 ${u.secret}`);
    else L.push(`username ${u.name}${priv} password ${secretLine(u.password ?? '', c.servicePasswordEncryption)}`);
  }
  if (c.users.length) L.push('!');
  if (!c.domainLookup) L.push('no ip domain-lookup');
  if (c.domainName) L.push(`ip domain-name ${c.domainName}`);
  if (c.sshVersion) L.push(`ip ssh version ${c.sshVersion}`);
  if (spec.kind === 'l3switch' && c.ipRouting) L.push('ip routing');
  if (!c.cdpRun) L.push('no cdp run');
  L.push('!');
  if (spec.kind !== 'router') {
    L.push('spanning-tree mode pvst');
    for (const [vlan, prio] of [...c.stpPriority].sort((a, b) => a[0] - b[0])) L.push(`spanning-tree vlan ${vlan} priority ${prio}`);
    L.push('!');
  }
  for (const name of sortInterfaces([...c.interfaces.keys()], physicalOrder)) {
    const i = c.interfaces.get(name)!;
    L.push(`interface ${name}`);
    if (i.description) L.push(` description ${i.description}`);
    if (i.dot1q) L.push(` encapsulation dot1Q ${i.dot1q.vlan}${i.dot1q.native ? ' native' : ''}`);
    if (spec.kind === 'l3switch' && !name.startsWith('Vlan') && !i.switchport) L.push(' no switchport');
    if (i.switchport) {
      if (i.accessVlan !== 1) L.push(` switchport access vlan ${i.accessVlan}`);
      if (i.nativeVlan !== 1) L.push(` switchport trunk native vlan ${i.nativeVlan}`);
      if (i.allowed) L.push(` switchport trunk allowed vlan ${i.allowed.length ? formatVlanList(i.allowed) : 'none'}`);
      if (i.mode !== 'dynamic auto') L.push(` switchport mode ${i.mode}`);
      if (i.portfast) L.push(' spanning-tree portfast');
    } else {
      if (i.ip) L.push(` ip address ${ipToString(i.ip.address)} ${ipToString(i.ip.mask)}`);
      else L.push(' no ip address');
      for (const h of i.helpers) L.push(` ip helper-address ${ipToString(h)}`);
      if (i.aclIn) L.push(` ip access-group ${i.aclIn} in`);
      if (i.aclOut) L.push(` ip access-group ${i.aclOut} out`);
      if (!i.proxyArp) L.push(' no ip proxy-arp');
      if (i.natInside) L.push(' ip nat inside');
      if (i.natOutside) L.push(' ip nat outside');
      for (const a of i.ipv6) L.push(` ipv6 address ${ip6ToString(a.ip)}/${a.len}`);
      if (i.ipv6Enable) L.push(' ipv6 enable');
    }
    if (!name.startsWith('Vlan') && !name.includes('.') && !name.startsWith('Serial')) {
      if (i.duplex !== 'auto') L.push(` duplex ${i.duplex}`);
      if (i.speed !== 'auto') L.push(` speed ${i.speed}`);
    }
    if (i.clockRate) L.push(` clock rate ${i.clockRate}`);
    if (i.shutdown) L.push(' shutdown');
    L.push('!');
  }
  if (c.rip) {
    L.push('router rip');
    if (c.rip.version) L.push(` version ${c.rip.version}`);
    for (const p of c.rip.passive) L.push(` passive-interface ${p}`);
    for (const n of c.rip.networks) L.push(` network ${ipToString(n)}`);
    if (c.rip.defaultOriginate) L.push(' default-information originate');
    if (!c.rip.autoSummary) L.push(' no auto-summary');
    L.push('!');
  }
  if (c.ospf) {
    L.push(`router ospf ${c.ospf.pid}`);
    if (c.ospf.routerId !== undefined) L.push(` router-id ${ipToString(c.ospf.routerId)}`);
    for (const p of c.ospf.passive) L.push(` passive-interface ${p}`);
    for (const n of c.ospf.networks) L.push(` network ${ipToString(n.ip)} ${ipToString(n.wildcard)} area ${n.area}`);
    if (c.ospf.defaultOriginate) L.push(' default-information originate');
    L.push('!');
  }
  for (const [lo, hi] of c.dhcpExcluded) L.push(`ip dhcp excluded-address ${ipToString(lo)}${hi !== lo ? ` ${ipToString(hi)}` : ''}`);
  for (const pool of c.dhcpPools.values()) {
    L.push(`ip dhcp pool ${pool.name}`);
    if (pool.network) L.push(` network ${ipToString(pool.network.ip)} ${ipToString(pool.network.mask)}`);
    if (pool.router !== undefined) L.push(` default-router ${ipToString(pool.router)}`);
    if (pool.dns !== undefined) L.push(` dns-server ${ipToString(pool.dns)}`);
    if (pool.domain) L.push(` domain-name ${pool.domain}`);
    L.push('!');
  }
  for (const [name, p] of c.nat.pools) L.push(`ip nat pool ${name} ${ipToString(p.start)} ${ipToString(p.end)} netmask ${ipToString(p.mask)}`);
  for (const d of c.nat.dynamic) L.push(`ip nat inside source list ${d.acl} ${d.pool ? `pool ${d.pool}` : `interface ${d.iface}`}${d.overload ? ' overload' : ''}`);
  for (const st of c.nat.statics) L.push(`ip nat inside source static ${ipToString(st.local)} ${ipToString(st.global)}`);
  if (c.ipv6Routing) L.push('ipv6 unicast-routing');
  for (const r of c.ipv6Routes) L.push(`ipv6 route ${ip6ToString(r.prefix)}/${r.len} ${r.iface ?? ''}${r.iface && r.nextHop !== undefined ? ' ' : ''}${r.nextHop !== undefined ? ip6ToString(r.nextHop) : ''}${r.distance !== 1 ? ` ${r.distance}` : ''}`);
  if (c.defaultGateway !== undefined) L.push(`ip default-gateway ${ipToString(c.defaultGateway)}`);
  for (const r of c.staticRoutes) {
    const via = r.iface ? r.iface + (r.nextHop !== undefined ? ` ${ipToString(r.nextHop)}` : '') : ipToString(r.nextHop!);
    L.push(`ip route ${ipToString(r.network)} ${ipToString(r.mask)} ${via}${r.distance !== 1 ? ` ${r.distance}` : ''}`);
  }
  if (c.defaultGateway !== undefined || c.staticRoutes.length) L.push('!');
  const numbered = [...c.acls.keys()].filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  for (const k of numbered) for (const e of c.acls.get(k)!) L.push(aclEntryText(k, e, true));
  if (numbered.length) L.push('!');
  if (c.bannerMotd !== undefined) L.push(`banner motd ^C${c.bannerMotd}^C`, '!');
  L.push('line con 0', ...lineBody(c.con, c.servicePasswordEncryption, false), '!');
  L.push('line vty 0 4', ...lineBody(c.vty, c.servicePasswordEncryption, true), '!');
  L.push('end');
  return L.join('\n') + '\n';
}

function lineBody(l: LineConfig, enc: boolean, vty: boolean): string[] {
  const out: string[] = [];
  if (l.execTimeout) out.push(` exec-timeout ${l.execTimeout[0]} ${l.execTimeout[1]}`);
  if (l.password !== undefined) out.push(` password ${secretLine(l.password, enc)}`);
  if (l.loggingSync) out.push(' logging synchronous');
  if (l.login === 'line') out.push(' login');
  else if (l.login === 'local') out.push(' login local');
  else if (vty) out.push(' no login');
  if (vty && l.transport !== 'all') out.push(` transport input ${l.transport}`);
  return out;
}
