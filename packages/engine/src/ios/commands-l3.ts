/** IOS commands for RIP, OSPF, DHCP server, NAT/PAT, IPv6 and TFTP transfers. */
import type { DeviceKind } from '../model/types';
import { classfulMask, ipToString, maskToPrefix, networkOf, parseIp } from '../net/ipv4';
import { ip6ToString, isLinkLocal, network6, parseCidr6, parseIp6 } from '../net/ipv6';
import { showNat } from '../sim/nat';
import { type Args, def, type Tree } from './parser';
import { replay } from './load';
import type { Ctx } from './session';
import * as show from './show';

type T = Tree<Ctx>;

export interface L3Trees {
  user: T;
  priv: T;
  config: T;
  cif: T;
  router: T;
  dhcp: T;
  canonicalIf(c: Ctx, name: string): string | null;
  targets(c: Ctx): ReturnType<Ctx['c']['interfaces']['get']>[];
}

function rip(c: Ctx) {
  return (c.c.rip ??= { networks: [], passive: [], autoSummary: c.d.spec.localRoutes ? false : true, defaultOriginate: false });
}

export function defineL3(t: L3Trees, kind: DeviceKind): void {
  const routing = kind === 'router' || kind === 'l3switch';
  const { config, cif, router, dhcp, priv, user } = t;

  if (routing) {
    // ------------------------------------------------------------------ RIP / OSPF
    def(config, 'router rip', (c) => {
      rip(c);
      c.s.routerTarget = 'rip';
      c.s.mode = 'config-router';
    }, ['Enable a routing process', 'Routing Information Protocol (RIP)']);
    def(config, 'no router rip', (c) => delete c.c.rip);
    def(config, 'router ospf <1-65535>', (c, a) => {
      const pid = Number(a.p[0]);
      if (c.c.ospf && c.c.ospf.pid !== pid) return c.out('% TPacket supports a single OSPF process per router');
      c.c.ospf ??= { pid, networks: [], passive: [], defaultOriginate: false };
      c.s.routerTarget = 'ospf';
      c.s.mode = 'config-router';
    }, ['', 'Open Shortest Path First (OSPF)', 'Process ID']);
    def(config, 'no router ospf <1-65535>', (c) => delete c.c.ospf);

    const onlyRip = (fn: (c: Ctx, a: Args) => void) => (c: Ctx, a: Args) => (c.s.routerTarget === 'rip' ? fn(c, a) : c.invalid(0));
    const onlyOspf = (fn: (c: Ctx, a: Args) => void) => (c: Ctx, a: Args) => (c.s.routerTarget === 'ospf' ? fn(c, a) : c.invalid(0));
    def(router, 'version <1-2>', onlyRip((c, a) => (rip(c).version = Number(a.p[0]) as 1 | 2)), ['Set routing protocol version', 'version']);
    def(router, 'no version', onlyRip((c) => delete rip(c).version));
    def(router, 'auto-summary', onlyRip((c) => (rip(c).autoSummary = true)), ['Enable automatic network number summarization']);
    def(router, 'no auto-summary', onlyRip((c) => (rip(c).autoSummary = false)));
    def(router, 'network <ip>', (c, a) => {
      if (c.s.routerTarget === 'ospf') return c.out('% Incomplete command.');
      const ip = parseIp(a.p[0]!)!;
      const major = networkOf(ip, classfulMask(ip));
      const r = rip(c);
      if (!r.networks.includes(major)) r.networks.push(major);
    }, ['Enable routing on an IP network', 'Network number']);
    def(router, 'no network <ip>', onlyRip((c, a) => {
      const ip = parseIp(a.p[0]!)!;
      const major = networkOf(ip, classfulMask(ip));
      rip(c).networks = rip(c).networks.filter((n) => n !== major);
    }));
    def(router, 'network <ip> <ip> area <0-4294967295>', onlyOspf((c, a) => {
      const ip = parseIp(a.p[0]!)!;
      const wildcard = parseIp(a.p[1]!)!;
      const area = Number(a.p[2]);
      const o = c.c.ospf!;
      const base = (ip & ~wildcard) >>> 0;
      const ex = o.networks.find((n) => n.ip === base && n.wildcard === wildcard);
      if (ex) ex.area = area;
      else o.networks.push({ ip: base, wildcard, area });
    }), ['', 'Network number', 'OSPF wild card bits', 'Set the OSPF area ID', 'OSPF area ID as a decimal value']);
    def(router, 'no network <ip> <ip> area <0-4294967295>', onlyOspf((c, a) => {
      const ip = parseIp(a.p[0]!)!;
      const wildcard = parseIp(a.p[1]!)!;
      c.c.ospf!.networks = c.c.ospf!.networks.filter((n) => !(n.ip === ((ip & ~wildcard) >>> 0) && n.wildcard === wildcard));
    }));
    def(router, 'router-id <ip>', onlyOspf((c, a) => {
      c.c.ospf!.routerId = parseIp(a.p[0]!)!;
      if (!c.s.opts.replay) c.out('Reload or use "clear ip ospf process" command, for this to take effect');
    }), ['router-id for this OSPF process', 'OSPF router-id in IP address format']);
    def(router, 'no router-id', onlyOspf((c) => delete c.c.ospf!.routerId));
    const passive = (on: boolean) => (c: Ctx, a: Args) => {
      const n = t.canonicalIf(c, a.p[0]!);
      if (!n || !c.c.interfaces.has(n)) return c.out('%Invalid interface type and number');
      const list = c.s.routerTarget === 'rip' ? rip(c).passive : c.c.ospf!.passive;
      const i = list.indexOf(n);
      if (on && i < 0) list.push(n);
      if (!on && i >= 0) list.splice(i, 1);
    };
    def(router, 'passive-interface <iface>', passive(true), ['Suppress routing updates on an interface']);
    def(router, 'no passive-interface <iface>', passive(false));
    def(router, 'default-information originate', (c) => {
      if (c.s.routerTarget === 'rip') rip(c).defaultOriginate = true;
      else c.c.ospf!.defaultOriginate = true;
    }, ['Control distribution of default information', 'Distribute a default route']);
    def(router, 'no default-information originate', (c) => {
      if (c.s.routerTarget === 'rip') rip(c).defaultOriginate = false;
      else c.c.ospf!.defaultOriginate = false;
    });
    def(router, 'exit', (c) => (c.s.mode = 'config'));

    // ------------------------------------------------------------------ DHCP server
    def(config, 'ip dhcp pool <WORD>', (c, a) => {
      const name = a.p[0]!.slice(0, 64);
      if (!c.c.dhcpPools.has(name)) c.c.dhcpPools.set(name, { name });
      c.s.dhcpTarget = name;
      c.s.mode = 'config-dhcp';
    }, ['', 'Configure DHCP server and relay parameters', 'Configure DHCP address pools', 'Pool name']);
    def(config, 'no ip dhcp pool <WORD>', (c, a) => void c.c.dhcpPools.delete(a.p[0]!));
    const excl = (c: Ctx, a: Args) => {
      const lo = parseIp(a.p[0]!)!;
      const hi = a.p[1] ? parseIp(a.p[1])! : lo;
      if (hi < lo) return c.out('% Invalid address range');
      if (!c.c.dhcpExcluded.some(([x, y]) => x === lo && y === hi)) c.c.dhcpExcluded.push([lo, hi]);
    };
    def(config, 'ip dhcp excluded-address <ip>', excl, ['', '', 'Prevent DHCP from assigning certain addresses', 'Low IP address']);
    def(config, 'ip dhcp excluded-address <ip> <ip>', excl, ['', '', '', '', 'High IP address']);
    def(config, 'no ip dhcp excluded-address <ip>', (c, a) => (c.c.dhcpExcluded = c.c.dhcpExcluded.filter(([x]) => x !== parseIp(a.p[0]!))));
    def(config, 'no ip dhcp excluded-address <ip> <ip>', (c, a) => (c.c.dhcpExcluded = c.c.dhcpExcluded.filter(([x]) => x !== parseIp(a.p[0]!))));
    const pool = (c: Ctx) => c.c.dhcpPools.get(c.s.dhcpTarget)!;
    def(dhcp, 'network <ip> <ip>', (c, a) => {
      const ip = parseIp(a.p[0]!)!;
      const mask = parseIp(a.p[1]!)!;
      if (maskToPrefix(mask) === null) return c.out('% Invalid mask');
      pool(c).network = { ip: networkOf(ip, mask), mask };
    }, ['Network number and mask', 'Network number in dotted-decimal notation', 'Network mask']);
    def(dhcp, 'default-router <ip>', (c, a) => (pool(c).router = parseIp(a.p[0]!)!), ['Default routers', 'Router\'s IP address']);
    def(dhcp, 'dns-server <ip>', (c, a) => (pool(c).dns = parseIp(a.p[0]!)!), ['DNS servers', 'Server\'s IP address']);
    def(dhcp, 'domain-name <WORD>', (c, a) => (pool(c).domain = a.p[0]!.slice(0, 100)), ['Domain name', 'Domain name']);
    def(dhcp, 'no default-router', (c) => delete pool(c).router);
    def(dhcp, 'no dns-server', (c) => delete pool(c).dns);
    def(dhcp, 'no network', (c) => delete pool(c).network);
    def(dhcp, 'exit', (c) => (c.s.mode = 'config'));

    // ------------------------------------------------------------------ NAT / PAT
    def(cif, 'ip nat inside', (c) => t.targets(c).forEach((i) => { i!.natInside = true; i!.natOutside = false; }), ['', 'NAT interface commands', 'Inside interface for address translation']);
    def(cif, 'ip nat outside', (c) => t.targets(c).forEach((i) => { i!.natOutside = true; i!.natInside = false; }), ['', '', 'Outside interface for address translation']);
    def(cif, 'no ip nat inside', (c) => t.targets(c).forEach((i) => delete i!.natInside));
    def(cif, 'no ip nat outside', (c) => t.targets(c).forEach((i) => delete i!.natOutside));
    def(config, 'ip nat inside source static <ip> <ip>', (c, a) => {
      const local = parseIp(a.p[0]!)!;
      const global = parseIp(a.p[1]!)!;
      c.c.nat.statics = c.c.nat.statics.filter((s) => s.local !== local);
      c.c.nat.statics.push({ local, global });
    }, ['', 'NAT configuration commands', 'Inside address translation', 'Source address translation', 'Static local->global mapping', 'Inside local IP address', 'Inside global IP address']);
    def(config, 'no ip nat inside source static <ip> <ip>', (c, a) => (c.c.nat.statics = c.c.nat.statics.filter((s) => s.local !== parseIp(a.p[0]!))));
    const dyn = (c: Ctx, rule: { acl: string; pool?: string; iface?: string; overload: boolean }) => {
      if (rule.iface) {
        const n = t.canonicalIf(c, rule.iface);
        if (!n || !c.c.interfaces.has(n)) return c.out('%Invalid interface type and number');
        rule.iface = n;
      }
      c.c.nat.dynamic = c.c.nat.dynamic.filter((r) => r.acl !== rule.acl);
      c.c.nat.dynamic.push(rule);
    };
    def(config, 'ip nat inside source list <1-199> interface <iface> overload', (c, a) => dyn(c, { acl: a.p[0]!, iface: a.p[1]!, overload: true }), ['', '', '', '', 'Specify access list describing local addresses', 'Access list number', 'Specify interface for global address', '', 'Overload an address translation']);
    def(config, 'ip nat inside source list <1-199> pool <WORD>', (c, a) => dyn(c, { acl: a.p[0]!, pool: a.p[1]!, overload: false }));
    def(config, 'ip nat inside source list <1-199> pool <WORD> overload', (c, a) => dyn(c, { acl: a.p[0]!, pool: a.p[1]!, overload: true }));
    def(config, 'no ip nat inside source list <1-199>', (c, a) => (c.c.nat.dynamic = c.c.nat.dynamic.filter((r) => r.acl !== a.p[0])));
    def(config, 'ip nat pool <WORD> <ip> <ip> netmask <ip>', (c, a) => {
      const start = parseIp(a.p[1]!)!;
      const end = parseIp(a.p[2]!)!;
      const mask = parseIp(a.p[3]!)!;
      if (end < start || networkOf(start, mask) !== networkOf(end, mask)) return c.out('%Start and end addresses on different subnets');
      c.c.nat.pools.set(a.p[0]!, { start, end, mask });
    }, ['', '', 'Define pool of addresses', 'Pool name', 'Start IP address', 'End IP address', 'Specify the network mask', 'Network mask']);
    def(config, 'no ip nat pool <WORD>', (c, a) => void c.c.nat.pools.delete(a.p[0]!));
    for (const tr of [priv]) def(tr, 'clear ip nat translation *', (c) => (c.d.natTable = []), ['Reset functions', '', 'Clear NAT', 'Clear dynamic translation', 'Delete all dynamic translations']);
  }

  // ------------------------------------------------------------------ IPv6
  if (routing) {
    def(config, 'ipv6 unicast-routing', (c) => (c.c.ipv6Routing = true), ['IPv6 configuration commands', 'Enable unicast routing']);
    def(config, 'no ipv6 unicast-routing', (c) => (c.c.ipv6Routing = false));
    const route6 = (c: Ctx, a: Args, distance: number) => {
      const pfx = parseCidr6(a.p[0]!);
      if (!pfx) return c.invalid(2);
      const nh = parseIp6(a.p[1]!);
      let iface: string | undefined;
      if (nh === null) {
        const n = t.canonicalIf(c, a.p[1]!.replace(/^([a-zA-Z]+)\s*/, '$1'));
        if (!n || !c.c.interfaces.has(n)) return c.out('%Invalid interface type and number');
        iface = n;
      }
      c.c.ipv6Routes.push({ prefix: network6(pfx.ip, pfx.len), len: pfx.len, distance, ...(nh !== null ? { nextHop: nh } : {}), ...(iface ? { iface } : {}) });
    };
    def(config, 'ipv6 route <X:X::X:X/len> <WORD>', (c, a) => route6(c, a, 1), ['', 'Configure static routes', 'IPv6 prefix', 'IPv6 address of next-hop or outgoing interface']);
    def(config, 'ipv6 route <X:X::X:X/len> <WORD> <1-254>', (c, a) => route6(c, a, Number(a.p[2])));
    def(config, 'no ipv6 route <X:X::X:X/len>', (c, a) => {
      const pfx = parseCidr6(a.p[0]!);
      if (pfx) c.c.ipv6Routes = c.c.ipv6Routes.filter((r) => !(r.prefix === network6(pfx.ip, pfx.len) && r.len === pfx.len));
    });
  }
  def(cif, 'ipv6 address <X:X::X:X/len>', (c, a) => {
    const v = parseCidr6(a.p[0]!);
    if (!v || isLinkLocal(v.ip)) return c.invalid(2);
    for (const i of t.targets(c)) {
      if (i!.switchport) return c.out('% IPv6 addresses may not be configured on L2 links.');
      if (!i!.ipv6.some((x) => x.ip === v.ip)) i!.ipv6.push(v);
    }
  }, ['IPv6 interface subcommands', 'Configure IPv6 address on interface', 'IPv6 prefix']);
  def(cif, 'no ipv6 address', (c) => t.targets(c).forEach((i) => (i!.ipv6 = [])));
  def(cif, 'no ipv6 address <X:X::X:X/len>', (c, a) => {
    const v = parseCidr6(a.p[0]!);
    t.targets(c).forEach((i) => (i!.ipv6 = i!.ipv6.filter((x) => x.ip !== v?.ip)));
  });
  def(cif, 'ipv6 enable', (c) => t.targets(c).forEach((i) => (i!.ipv6Enable = true)), ['', 'Enable IPv6 on interface']);
  def(cif, 'no ipv6 enable', (c) => t.targets(c).forEach((i) => (i!.ipv6Enable = false)));

  // ------------------------------------------------------------------ show / copy
  for (const tr of [user, priv]) {
    def(tr, 'show ipv6 interface brief', (c) => c.out(show.showIpv6Brief(c.net, c.d)));
    def(tr, 'show ipv6 route', (c) => c.out(show.showIpv6Route(c.net, c.d)));
    if (routing) {
      def(tr, 'show ip protocols', (c) => c.out(show.showIpProtocols(c.net, c.d)), ['', '', 'IP routing protocol process parameters and statistics']);
      def(tr, 'show ip ospf neighbor', (c) => c.out(show.showOspfNeighbors(c.net, c.d)), ['', '', 'OSPF information', 'Neighbor list']);
      def(tr, 'show ip dhcp binding', (c) => c.out(show.showDhcpBinding(c.d)), ['', '', 'Show items in the DHCP database', 'DHCP address bindings']);
      def(tr, 'show ip nat translations', (c) => c.out(showNat(c.d)), ['', '', 'IP NAT information', 'Translation entries']);
    }
  }
  const tftpHost = (c: Ctx, then: (ip: number, file: string) => void, defName: string) =>
    c.s.ask('Address or name of remote host []? ', (host) => {
      const ip = parseIp(host.trim());
      if (ip === null) return c.out('%Error parsing filename (Bad IP address)');
      c.s.ask(`Destination filename [${defName}]? `, (f) => then(ip, f.trim() || defName));
    });
  const upload = (which: 'running' | 'startup') => (c: Ctx) => {
    const content = which === 'running' ? c.net.runningConfig(c.d) : c.d.doc.startup;
    if (!content) return c.out('%Error opening nvram:startup-config (No such file or directory)');
    tftpHost(c, (ip, file) => {
      c.out(`Writing ${file}...`);
      const r = c.net.udpRequest(c.d.doc.id, ip, 69, { app: 'tftp', tftp: { op: 'WRQ', file, content } });
      if (r.kind === 'data' && r.data.app === 'tftp' && r.data.tftp.op === 'DATA') c.out('!!', `[OK - ${content.length} bytes]`, '', `${content.length} bytes copied in 0.1 secs`);
      else c.out('%Error opening tftp://' + ipToString(ip) + '/' + file + ' (Timed out)');
    }, `${c.c.hostname.toLowerCase()}-confg`);
  };
  def(priv, 'copy running-config tftp', upload('running'), ['', '', 'Copy to tftp: file system']);
  def(priv, 'copy startup-config tftp', upload('startup'));
  def(priv, 'copy tftp running-config', (c) =>
    c.s.ask('Address or name of remote host []? ', (host) => {
      const ip = parseIp(host.trim());
      if (ip === null) return c.out('%Error parsing filename (Bad IP address)');
      c.s.ask('Source filename []? ', (file) =>
        c.s.ask('Destination filename [running-config]? ', () => {
          c.out(`Accessing tftp://${ipToString(ip)}/${file.trim()}...`);
          const r = c.net.udpRequest(c.d.doc.id, ip, 69, { app: 'tftp', tftp: { op: 'RRQ', file: file.trim() } });
          if (r.kind !== 'data' || r.data.app !== 'tftp') return c.out(`%Error opening tftp://${ipToString(ip)}/${file.trim()} (Timed out)`);
          if (r.data.tftp.op === 'ERROR') return c.out(`%Error opening tftp://${ipToString(ip)}/${file.trim()} (No such file or directory)`);
          const text = r.data.tftp.content ?? '';
          const prev = c.s.mode;
          c.s.mode = 'config';
          const errs = replay(c.s, text);
          c.s.mode = prev;
          c.out(`Loading ${file.trim()} from ${ipToString(ip)}: !`, `[OK - ${text.length} bytes]`, ...errs, '', `${text.length} bytes copied in 0.1 secs`);
          c.net.console(c.d.doc.id, '%SYS-5-CONFIG_I: Configured from console by console');
        }),
      );
    }),
    ['', 'Copy from tftp: file system', 'Update (merge with) current system configuration'],
  );
  void ip6ToString;
}
