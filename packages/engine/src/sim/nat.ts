/**
 * IOS NAT / PAT (inside source): static, dynamic pool, and overload (PAT) on a pool or an interface.
 * Order of operations follows IOS: inside→outside = routing, then translation, then outbound ACL;
 * outside→inside = translation before routing.
 */
import { ipToString } from '../net/ipv4';
import type { Network, RtDevice } from './network';
import type { Ipv4Pkt } from './packets';

export interface NatEntry {
  proto: 'icmp' | 'udp' | 'tcp';
  il: number;
  ilPort: number;
  ig: number;
  igPort: number;
  ol: number;
  olPort: number;
  at: number;
}

function ports(p: Ipv4Pkt, side: 'src' | 'dst'): number {
  if (p.icmp) return p.icmp.ident;
  if (p.udp) return side === 'src' ? p.udp.sport : p.udp.dport;
  if (p.tcp) return side === 'src' ? p.tcp.sport : p.tcp.dport;
  return 0;
}

function withPort(p: Ipv4Pkt, side: 'src' | 'dst', port: number): Ipv4Pkt {
  const q = structuredClone(p);
  if (q.icmp && (q.icmp.type === 8 || q.icmp.type === 0)) q.icmp.ident = port;
  if (q.udp) side === 'src' ? (q.udp.sport = port) : (q.udp.dport = port);
  if (q.tcp) side === 'src' ? (q.tcp.sport = port) : (q.tcp.dport = port);
  return q;
}

/** Inside → outside. Returns the translated packet, the original when no rule applies, or null (no address left). */
export function natOutbound(net: Network, d: RtDevice, inIf: string, outIf: string, p: Ipv4Pkt): Ipv4Pkt | null {
  if (p.proto === 'ospf') return p;
  const c = d.ios!;
  if (!c.interfaces.get(inIf)?.natInside || !c.interfaces.get(outIf)?.natOutside) return p;
  const st = c.nat.statics.find((s) => s.local === p.src);
  if (st) return { ...p, src: st.global };
  const proto = p.proto;
  const ilPort = ports(p, 'src');
  const olPort = ports(p, 'dst');
  const existing = d.natTable.find((e) => e.proto === proto && e.il === p.src && e.ilPort === ilPort && e.ol === p.dst && (proto === 'icmp' || e.olPort === olPort));
  if (existing) {
    existing.at = net.now;
    return withPort({ ...p, src: existing.ig }, 'src', existing.igPort);
  }
  for (const rule of c.nat.dynamic) {
    if (!c.acls.has(rule.acl) || !net.aclPermits(d, rule.acl, p)) continue;
    let ig: number | undefined;
    let igPort = ilPort;
    if (rule.iface) ig = net.l3Ifs(d).find((i) => i.name === rule.iface)?.ip;
    const pool = rule.pool ? c.nat.pools.get(rule.pool) : undefined;
    if (rule.pool && !pool) continue;
    if (rule.overload) {
      ig ??= pool?.start;
      if (ig === undefined) continue;
      const used = (port: number) => d.natTable.some((e) => e.proto === proto && e.ig === ig && e.igPort === port);
      while (used(igPort)) igPort = igPort < 1024 ? 1024 : igPort + 1;
    } else if (pool) {
      const mine = d.natTable.find((e) => e.il === p.src);
      if (mine) ig = mine.ig;
      else {
        for (let a = pool.start; a <= pool.end; a++) {
          if (!d.natTable.some((e) => e.ig === a) && !c.nat.statics.some((s) => s.global === a)) {
            ig = a;
            break;
          }
        }
      }
      if (ig === undefined) return null;
    }
    if (ig === undefined) continue;
    d.natTable.push({ proto, il: p.src, ilPort, ig, igPort, ol: p.dst, olPort, at: net.now });
    return withPort({ ...p, src: ig }, 'src', igPort);
  }
  return p;
}

/** Outside → inside: reverse translation of the destination. */
export function natInbound(d: RtDevice, inIf: string, p: Ipv4Pkt): Ipv4Pkt {
  const c = d.ios!;
  if (!c.interfaces.get(inIf)?.natOutside) return p;
  const port = ports(p, 'dst');
  const e = d.natTable.find((x) => x.ig === p.dst && x.proto === p.proto && x.igPort === port);
  if (e) return withPort({ ...p, dst: e.il }, 'dst', e.ilPort);
  const st = c.nat.statics.find((s) => s.global === p.dst);
  if (st) return { ...p, dst: st.local };
  return p;
}

export function showNat(d: RtDevice): string {
  const L = ['Pro  Inside global         Inside local          Outside local         Outside global'];
  const pad = (s: string) => s.padEnd(22);
  for (const e of d.natTable) {
    const og = `${ipToString(e.ol)}:${e.olPort}`;
    L.push(`${e.proto.padEnd(5)}${pad(`${ipToString(e.ig)}:${e.igPort}`)}${pad(`${ipToString(e.il)}:${e.ilPort}`)}${pad(og)}${og}`);
  }
  for (const s of d.ios!.nat.statics) L.push(`---  ${pad(ipToString(s.global))}${pad(ipToString(s.local))}${pad('---')}---`);
  return L.join('\n');
}
