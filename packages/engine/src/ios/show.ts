import { classfulMask, ipToString, maskToPrefix, networkOf } from '../net/ipv4';
import { macCisco } from '../net/mac';
import type { Network, Route, RtDevice } from '../sim/network';
import { ip6ToString } from '../net/ipv6';
import { aclEntryText, formatVlanList, ifAbbrev, ifShort, sortInterfaces } from './config';

const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s.padEnd(n));

/** Simulated calendar starts like a Cisco box without NTP: 00:00 UTC Mon Mar 1 1993. */
const EPOCH = Date.UTC(1993, 2, 1);

export function clockText(net: Network, d: RtDevice): string {
  const t = new Date(EPOCH + d.clockOffset + net.now);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  const ss = String(t.getUTCSeconds()).padStart(2, '0');
  const ms = String(t.getUTCMilliseconds()).padStart(3, '0');
  return `${d.clockOffset ? '' : '*'}${hh}:${mm}:${ss}.${ms} UTC ${days[t.getUTCDay()]} ${months[t.getUTCMonth()]} ${t.getUTCDate()} ${t.getUTCFullYear()}`;
}

export function uptimeText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m || (!d && !h)) parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
  if (!d && !h && !m) return `${s} seconds`;
  return parts.join(', ');
}

function statusWords(net: Network, d: RtDevice, name: string): [string, string] {
  const st = net.ifStatus(d, name);
  if (st.adminDown) return ['administratively down', 'down'];
  return [st.l1 ? 'up' : 'down', st.proto ? 'up' : 'down'];
}

export function ipIntBrief(net: Network, d: RtDevice): string {
  const c = d.ios!;
  const L = ['Interface              IP-Address      OK? Method Status                Protocol '];
  for (const name of sortInterfaces([...c.interfaces.keys()], d.dataPorts())) {
    const i = c.interfaces.get(name)!;
    const [st, pr] = statusWords(net, d, name);
    const ip = i.ip && !i.switchport ? ipToString(i.ip.address) : 'unassigned';
    const method = i.ip && !i.switchport ? 'manual' : 'unset ';
    L.push(`${pad(name, 23)}${pad(ip, 16)}YES ${method} ${pad(st, 22)}${pr} `);
  }
  return L.join('\n');
}

function hardware(d: RtDevice, name: string): string {
  if (name.startsWith('Vlan')) return 'CPU Interface';
  if (name.startsWith('Serial')) return 'GT96K Serial';
  if (name.startsWith('Loopback')) return 'Loopback';
  if (name.startsWith('Gigabit')) return d.kind === 'router' ? 'CN Gigabit Ethernet' : 'Lance';
  return d.kind === 'router' ? 'Fast Ethernet' : 'Lance';
}

export function showInterfaces(net: Network, d: RtDevice, only?: string): string {
  const c = d.ios!;
  const names = only ? [only] : sortInterfaces([...c.interfaces.keys()], d.dataPorts());
  const L: string[] = [];
  for (const name of names) {
    const i = c.interfaces.get(name);
    if (!i) continue;
    const [st, pr] = statusWords(net, d, name);
    const sw = i.switchport ? (pr === 'up' ? ' (connected)' : ' (notconnect)') : '';
    L.push(`${name} is ${st}, line protocol is ${pr}${sw}`);
    if (name.startsWith('Serial')) L.push(`  Hardware is ${hardware(d, name)}`);
    else if (!name.startsWith('Loopback')) {
      const mac = macCisco(net.ifMac(d, name));
      L.push(`  Hardware is ${hardware(d, name)}, address is ${mac} (bia ${mac})`);
    } else L.push(`  Hardware is ${hardware(d, name)}`);
    if (i.description) L.push(`  Description: ${i.description}`);
    if (i.ip && !i.switchport) L.push(`  Internet address is ${ipToString(i.ip.address)}/${maskToPrefix(i.ip.mask)}`);
    const port = d.ports.get(name.split('.')[0]!);
    const speed = port?.spec.speed ?? 0;
    const bw = name.startsWith('Serial') ? 1544 : name.startsWith('Vlan') || name.startsWith('Loopback') ? (name.startsWith('Loopback') ? 8000000 : 100000) : speed * 1000;
    L.push(`  MTU 1500 bytes, BW ${bw} Kbit, DLY ${name.startsWith('Serial') ? 20000 : speed >= 1000 ? 10 : 100} usec,`);
    L.push('     reliability 255/255, txload 1/255, rxload 1/255');
    if (name.startsWith('Serial')) {
      const pr2 = net.peer(d.doc.id, name);
      L.push('  Encapsulation HDLC, loopback not set, keepalive set (10 sec)');
      if (pr2) {
        const dce = net.serialDce(pr2.link);
        const isDce = dce.device === d.doc.id && dce.port === name;
        L.push(`  ${isDce ? 'DCE' : 'DTE'} cable attached${isDce && i.clockRate ? `, clock rate ${i.clockRate}` : isDce ? ', clock rate not set' : ''}`);
      } else L.push('  No cable attached');
    } else if (i.dot1q) {
      L.push(`  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${i.dot1q.vlan}`);
    } else {
      L.push('  Encapsulation ARPA, loopback not set');
      if (port && !name.includes('.')) {
        const up = pr === 'up';
        const sp = i.speed === 'auto' ? speed : Number(i.speed);
        L.push(up ? `  ${i.duplex === 'half' ? 'Half' : 'Full'}-duplex, ${sp >= 1000 ? '1000' : sp}Mb/s` : '  Auto-duplex, Auto-speed');
      }
      L.push('  ARP type: ARPA, ARP Timeout 04:00:00');
    }
    if (i.aclIn || i.aclOut) L.push(`  Inbound  access list is ${i.aclIn ?? 'not set'}`, `  Outgoing access list is ${i.aclOut ?? 'not set'}`);
  }
  return L.join('\n');
}

function routeLine(r: Route, full: boolean): string {
  const code = r.type === 'O' && r.external ? 'O*E2' : r.candidateDefault ? `${r.type}*` : r.type;
  const net = full ? `${ipToString(r.network)}/${maskToPrefix(r.mask)}` : ipToString(r.network);
  if (r.type === 'C' || r.type === 'L') return `${code}       ${net} is directly connected, ${r.iface}`;
  if (r.nextHop === undefined) return `${code}       ${net} is directly connected, ${r.iface}`;
  return `${code}       ${net} [${r.ad}/${r.metric}] via ${ipToString(r.nextHop)}${r.iface ? `, ${r.iface}` : ''}`;
}

export function showIpRoute(net: Network, d: RtDevice): string {
  const L = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
    '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
    '       * - candidate default, U - per-user static route, o - ODR',
    '       P - periodic downloaded static route',
    '',
  ];
  if (!net.routingEnabled(d)) {
    const gw = d.ios?.defaultGateway;
    L.splice(0, L.length, gw !== undefined ? `Default gateway is ${ipToString(gw)}` : 'Default gateway is not set', '', 'Host               Gateway           Last Use    Total Uses  Interface', 'ICMP redirect cache is empty');
    return L.join('\n');
  }
  const routes = net.routes(d);
  const def = routes.find((r) => r.mask === 0 && r.type === 'S');
  L.push(def ? `Gateway of last resort is ${def.nextHop !== undefined ? ipToString(def.nextHop) : '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  const groups = new Map<number, Route[]>();
  for (const r of routes) {
    if (r.mask === 0) continue;
    const major = networkOf(r.network, classfulMask(r.network));
    const g = groups.get(major) ?? [];
    g.push(r);
    groups.set(major, g);
  }
  const body: string[] = [];
  for (const major of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(major)!.sort((a, b) => a.network - b.network || (a.mask >>> 0) - (b.mask >>> 0));
    const cm = classfulMask(major);
    if (g.length === 1 && g[0]!.mask === cm) {
      body.push(routeLine(g[0]!, true).replace(/^(\S+)\s+/, (_m, c: string) => c.padEnd(5)));
      continue;
    }
    const masks = new Set(g.map((r) => r.mask));
    if (masks.size === 1) {
      body.push(`     ${ipToString(major)}/${maskToPrefix(g[0]!.mask)} is subnetted, ${g.length} subnets`);
      for (const r of g) body.push(routeLine(r, false));
    } else {
      body.push(`     ${ipToString(major)}/${maskToPrefix(cm)} is variably subnetted, ${g.length} subnets, ${masks.size} masks`);
      for (const r of g) body.push(routeLine(r, true));
    }
  }
  const defLines = routes.filter((r) => r.mask === 0).map((r) => routeLine(r, true).replace(/^(\S+)\s+/, (_m, c: string) => c.padEnd(5)));
  if (d.spec.localRoutes) L.push(...defLines, ...body);
  else L.push(...body, ...defLines);
  return L.join('\n');
}

export function showArp(net: Network, d: RtDevice): string {
  const L = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const rows: [number, string][] = [];
  for (const i of net.l3Ifs(d)) if (net.ifUp(d, i.name)) rows.push([i.ip, `Internet  ${pad(ipToString(i.ip), 17)}${'-'.padStart(9)}   ${macCisco(i.mac)}  ARPA   ${i.name}`]);
  for (const [ip, e] of d.arp) {
    if (!net.arpLookup(d, ip)) continue;
    const age = Math.floor((net.now - e.at) / 60000);
    rows.push([ip, `Internet  ${pad(ipToString(ip), 17)}${String(age).padStart(9)}   ${macCisco(e.mac)}  ARPA   ${e.iface}`]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return [...L, ...rows.map((r) => r[1])].join('\n');
}

export function showMacTable(net: Network, d: RtDevice): string {
  const L = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----', ''];
  const entries = [...d.macTable.values()].filter((e) => net.now - e.at < 300_000).sort((a, b) => a.vlan - b.vlan || (a.mac < b.mac ? -1 : 1));
  for (const e of entries) L.push(`${String(e.vlan).padStart(4)}    ${macCisco(e.mac)}    DYNAMIC     ${ifAbbrev(e.port)}`);
  return L.join('\n');
}

export function showVlanBrief(net: Network, d: RtDevice, brief: boolean): string {
  const L = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  const c = d.ios!;
  for (const v of net.allVlans(d)) {
    const ports = d.dataPorts().filter((p) => {
      const i = c.interfaces.get(p);
      return i?.switchport && !net.isTrunk(d, p) && i.accessVlan === v.id;
    }).map(ifAbbrev);
    const status = v.id >= 1002 ? 'active' : 'active';
    const chunks: string[] = [];
    for (let k = 0; k < ports.length; k += 4) chunks.push(ports.slice(k, k + 4).join(', '));
    L.push(`${pad(String(v.id), 5)}${pad(v.name, 33)}${pad(status, 10)}${chunks[0] ?? ''}`.trimEnd());
    for (const ch of chunks.slice(1)) L.push(`${' '.repeat(48)}${ch}`);
  }
  if (!brief) {
    L.push('', 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2', '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------');
    for (const v of net.allVlans(d)) L.push(`${pad(String(v.id), 5)}${pad(v.id >= 1002 ? (v.id === 1003 ? 'tr' : 'fddi') : 'enet', 6)}${pad(String(100000 + v.id), 11)}1500  -      -      -        -    -        0      0`);
  }
  return L.join('\n');
}

export function showTrunk(net: Network, d: RtDevice): string {
  const c = d.ios!;
  const trunks = d.dataPorts().filter((p) => net.isTrunk(d, p) && net.portStatus(d.doc.id, p).proto);
  if (!trunks.length) return '';
  const L = ['Port        Mode         Encapsulation  Status        Native vlan'];
  for (const p of trunks) {
    const i = c.interfaces.get(p)!;
    const mode = i.mode === 'trunk' ? 'on' : i.mode === 'dynamic desirable' ? 'desirable' : 'auto';
    L.push(`${pad(ifAbbrev(p), 12)}${pad(mode, 13)}${pad('802.1q', 15)}${pad('trunking', 14)}${i.nativeVlan}`);
  }
  L.push('', 'Port        Vlans allowed on trunk');
  for (const p of trunks) {
    const i = c.interfaces.get(p)!;
    L.push(`${pad(ifAbbrev(p), 12)}${i.allowed ? formatVlanList(i.allowed) || 'none' : '1-1005'}`);
  }
  L.push('', 'Port        Vlans allowed and active in management domain');
  for (const p of trunks) L.push(`${pad(ifAbbrev(p), 12)}${formatVlanList(net.portVlans(d, p))}`);
  L.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
  for (const p of trunks) L.push(`${pad(ifAbbrev(p), 12)}${formatVlanList(net.portVlans(d, p).filter((v) => net.stpForwarding(d, p, v)))}`);
  return L.join('\n');
}

const PLATFORM: Record<string, string> = { router: 'R', switch: 'S', l3switch: 'S I', host: 'H' };

export function showCdp(net: Network, d: RtDevice): string {
  const L = [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone',
    'Device ID    Local Intrfce   Holdtme    Capability   Platform    Port ID',
  ];
  if (!d.ios?.cdpRun) return '% CDP is not enabled';
  for (const p of d.dataPorts()) {
    const pr = net.peer(d.doc.id, p);
    if (!pr || !net.portStatus(d.doc.id, p).proto) continue;
    const o = net.devices.get(pr.device)!;
    if (!o.ios?.cdpRun) continue;
    const sp = (n: string) => ifShort(n).replace(/^(\D+)/, '$1 ');
    L.push(`${pad(o.ios.hostname, 13)}${pad(sp(p), 16)}${pad('160', 11)}${pad(PLATFORM[o.kind] ?? '', 13)}${pad(o.spec.id, 12)}${sp(pr.port)}`);
  }
  return L.join('\n');
}

export function showSpanningTree(net: Network, d: RtDevice): string {
  const L: string[] = [];
  for (const v of net.allVlans(d).filter((x) => x.id < 1002)) {
    const info = net.stpInfo(d, v.id);
    const ports = d.dataPorts().filter((p) => net.stpRole(d, p, v.id));
    if (!info || !ports.length) continue;
    const root = info.bridges.find((b) => b.id === info.root)!;
    const me = info.bridges.find((b) => b.id === d.doc.id)!;
    L.push(`VLAN${String(v.id).padStart(4, '0')}`, '  Spanning tree enabled protocol ieee');
    L.push(`  Root ID    Priority    ${root.priority}`, `             Address     ${macCisco(root.mac)}`);
    if (root.id === d.doc.id) L.push('             This bridge is the root');
    else {
      const rp = info.rootPort!;
      L.push(`             Cost        ${info.cost}`, `             Port        ${d.ports.get(rp)!.index + 1}(${rp})`);
    }
    L.push('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec', '');
    L.push(`  Bridge ID  Priority    ${me.priority}  (priority ${me.priority - v.id} sys-id-ext ${v.id})`, `             Address     ${macCisco(me.mac)}`);
    L.push('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec', '             Aging Time  20', '');
    L.push('Interface        Role Sts Cost      Prio.Nbr Type', '---------------- ---- --- --------- -------- --------------------------------');
    for (const p of ports) {
      const role = net.stpRole(d, p, v.id)!;
      const r = role === 'root' ? 'Root' : role === 'designated' ? 'Desg' : 'Altn';
      const port = me.ports.find((x) => x.name === p)!;
      L.push(`${pad(ifAbbrev(p), 17)}${r} ${net.stpState(d, p, v.id)} ${pad(String(port.cost), 10)}128.${pad(String(port.index), 5)}P2p`);
    }
    L.push('');
  }
  return L.length ? L.join('\n') : 'No spanning tree instances exist.';
}

export function showAccessLists(d: RtDevice): string {
  const L: string[] = [];
  for (const [name, entries] of [...d.ios!.acls].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const n = Number(name);
    L.push(`${n >= 1 && n <= 99 ? 'Standard' : 'Extended'} IP access list ${name}`);
    entries.forEach((e, k) => L.push(`    ${(k + 1) * 10}${aclEntryText(name, e, false)}${e.matches ? ` (${e.matches} match(es))` : ''}`));
  }
  return L.join('\n');
}

export function showVersion(net: Network, d: RtDevice): string {
  const ios = d.spec.ios!;
  const L = [
    `Cisco IOS Software, ${d.spec.label} Software (${ios.image}), Version ${ios.version}, RELEASE SOFTWARE (fc1)`,
    'TPacket IOS emulation — not a Cisco product. No Cisco software is included.',
    '',
    `${d.ios!.hostname} uptime is ${uptimeText(net.now - d.bootAt)}`,
    'System returned to ROM by power-on',
    '',
    `${ios.platform} processor with ${ios.memory} bytes of memory.`,
  ];
  const fe = d.dataPorts().filter((p) => p.startsWith('FastEthernet')).length;
  const ge = d.dataPorts().filter((p) => p.startsWith('GigabitEthernet')).length;
  const se = d.dataPorts().filter((p) => p.startsWith('Serial')).length;
  if (fe) L.push(`${fe} FastEthernet interface${fe > 1 ? 's' : ''}`);
  if (ge) L.push(`${ge} Gigabit Ethernet interface${ge > 1 ? 's' : ''}`);
  if (se) L.push(`${se} Low-speed serial(sync/async) network interface(s)`);
  L.push(`${ios.flash} bytes of processor board System flash (Read/Write)`, '', 'Configuration register is 0x2102');
  return L.join('\n');
}

export function showIpProtocols(net: Network, d: RtDevice): string {
  const c = d.ios!;
  const L: string[] = [];
  if (c.rip) {
    const r = c.rip;
    const v = r.version;
    L.push('Routing Protocol is "rip"', 'Sending updates every 30 seconds, next due in 12 seconds', 'Invalid after 180 seconds, hold down 180, flushed after 240',
      'Outgoing update filter list for all interfaces is not set', 'Incoming update filter list for all interfaces is not set', 'Redistributing: rip',
      `Default version control: send version ${v ?? 1}, receive ${v ? `version ${v}` : 'any version'}`, '  Interface             Send  Recv  Triggered RIP  Key-chain');
    for (const i of net.l3Ifs(d)) {
      const major = networkOf(i.ip, classfulMask(i.ip));
      if (r.networks.includes(major) && !r.passive.includes(i.name) && net.ifUp(d, i.name)) L.push(`  ${pad(i.name, 22)}${pad(String(v ?? 1), 6)}${pad(v ? String(v) : '2 1', 6)}`);
    }
    L.push(`Automatic network summarization is ${r.autoSummary ? '' : 'not '}in effect`, 'Maximum path: 4', 'Routing for Networks:', ...r.networks.map((n) => `\t${ipToString(n)}`));
    if (r.passive.length) L.push('Passive Interface(s):', ...r.passive.map((p) => `\t${p}`));
    L.push('Routing Information Sources:', '\tGateway         Distance      Last Update');
    for (const g of net.dynamic().ripNeighbors.get(d.doc.id) ?? []) L.push(`\t${pad(ipToString(g), 16)}120           00:00:12`);
    L.push('Distance: (default is 120)', '');
  }
  if (c.ospf) {
    const o = c.ospf;
    const rid = net.dynamic().ospfRouterId.get(d.doc.id) ?? 0;
    L.push(`Routing Protocol is "ospf ${o.pid}"`, 'Outgoing update filter list for all interfaces is not set', 'Incoming update filter list for all interfaces is not set',
      `Router ID ${ipToString(rid)}`, `Number of areas in this router is ${new Set(o.networks.map((n) => n.area)).size}. ${new Set(o.networks.map((n) => n.area)).size} normal 0 stub 0 nssa`,
      'Maximum path: 4', 'Routing for Networks:', ...o.networks.map((n) => `    ${ipToString(n.ip)} ${ipToString(n.wildcard)} area ${n.area}`));
    if (o.passive.length) L.push('Passive Interface(s):', ...o.passive.map((p) => `    ${p}`));
    L.push('Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const n of net.dynamic().ospfNeighbors.get(d.doc.id) ?? []) L.push(`    ${pad(ipToString(n.routerId), 16)}110           00:00:08`);
    L.push('Distance: (default is 110)', '');
  }
  return L.join('\n');
}

export function showOspfNeighbors(net: Network, d: RtDevice): string {
  if (!d.ios!.ospf) return '';
  const L = ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  for (const n of net.dynamic().ospfNeighbors.get(d.doc.id) ?? []) {
    L.push(`${pad(ipToString(n.routerId), 16)}${pad('1', 6)}${pad(n.state, 16)}00:00:3${(n.routerId % 9) + 0}    ${pad(ipToString(n.address), 16)}${n.iface}`);
  }
  return L.join('\n');
}

export function showDhcpBinding(d: RtDevice): string {
  const L = ['IP address       Client-ID/              Lease expiration        Type', '                 Hardware address'];
  for (const [ip, b] of [...d.dhcpBindings].sort((a, b2) => a[0] - b2[0])) L.push(`${pad(ipToString(ip), 17)}${pad(macCisco(b.mac), 24)}${pad('--', 24)}Automatic`);
  return L.join('\n');
}

export function showIpv6Brief(net: Network, d: RtDevice): string {
  const L: string[] = [];
  const v6 = new Map(net.l3Ifs6(d).map((i) => [i.name, i]));
  for (const name of sortInterfaces([...d.ios!.interfaces.keys()], d.dataPorts())) {
    if (d.ios!.interfaces.get(name)!.switchport) continue;
    const [st, pr] = statusWords(net, d, name);
    L.push(`${pad(name, 23)}[${st === 'administratively down' ? 'administratively down' : st}/${pr}]`);
    const i = v6.get(name);
    if (!i) L.push('    unassigned');
    else {
      L.push(`    ${ip6ToString(i.ll)}`);
      for (const a of i.addrs) L.push(`    ${ip6ToString(a.ip)}`);
    }
  }
  return L.join('\n');
}

export function showIpv6Route(net: Network, d: RtDevice): string {
  const L = ['IPv6 Routing Table - default - ' + net.routes6(d).length + ' entries', 'Codes: C - Connected, L - Local, S - Static', ''];
  for (const r of net.routes6(d)) {
    L.push(`${r.type}   ${ip6ToString(r.prefix)}/${r.len} [${r.ad}/0]`);
    L.push(r.nextHop !== undefined ? `     via ${ip6ToString(r.nextHop)}${r.iface ? `, ${r.iface}` : ''}` : `     via ${r.iface}, ${r.type === 'L' ? 'receive' : 'directly connected'}`);
  }
  return L.join('\n');
}
