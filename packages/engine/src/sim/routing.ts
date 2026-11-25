/**
 * Dynamic routing: RIP (v1/v2) and single/multi-area OSPF.
 *
 * Both protocols are computed from the live topology — the state their packet exchanges
 * converge to — rather than by simulating every update/hello/LSA packet:
 *  - neighbours are discovered through the real layer-2 broadcast domain of each interface
 *    (VLANs, trunks, STP state, hubs, access points), so a wrong VLAN or a shut port breaks them;
 *  - RIP runs Bellman-Ford with hop counts (max 15), split horizon, passive interfaces,
 *    version compatibility and classful auto-summary;
 *  - OSPF forms adjacencies (same area, same mask, distinct router-ids, non-passive), elects the
 *    DR, and runs SPF with interface costs (reference bandwidth 100 Mbit/s).
 */
import { classfulMask, ipToString, networkOf, wildcardMatch } from '../net/ipv4';
import type { L3If, Network, Route, RtDevice } from './network';

export interface OspfNeighbor {
  routerId: number;
  address: number;
  iface: string;
  peerDevice: string;
  state: string;
}

export interface DynamicResult {
  routes: Map<string, Route[]>;
  ospfNeighbors: Map<string, OspfNeighbor[]>;
  ospfRouterId: Map<string, number>;
  ripNeighbors: Map<string, number[]>;
}

interface Endpoint {
  dev: RtDevice;
  iface: L3If;
}

function ripEnabled(c: NonNullable<RtDevice['ios']>['rip'], i: L3If): boolean {
  if (!c) return false;
  const major = networkOf(i.ip, classfulMask(i.ip));
  return c.networks.includes(major);
}

function ospfArea(d: RtDevice, i: L3If): number | undefined {
  const o = d.ios?.ospf;
  if (!o) return undefined;
  for (const n of o.networks) if (wildcardMatch(i.ip, n.ip, n.wildcard)) return n.area;
  return undefined;
}

export function ospfCost(d: RtDevice, iface: string): number {
  if (iface.startsWith('Loopback')) return 1;
  if (iface.startsWith('Serial')) return 64;
  const speed = d.ports.get(iface.split('.')[0]!)?.spec.speed ?? 100;
  return Math.max(1, Math.floor(100 / speed));
}

export function computeDynamic(net: Network): DynamicResult {
  const res: DynamicResult = { routes: new Map(), ospfNeighbors: new Map(), ospfRouterId: new Map(), ripNeighbors: new Map() };
  const routers = [...net.devices.values()].filter((d) => d.doc.powered && net.routingEnabled(d) && (d.ios!.rip || d.ios!.ospf));
  if (!routers.length) return res;
  const upIfs = new Map<string, L3If[]>(routers.map((d) => [d.doc.id, net.l3Ifs(d).filter((i) => net.ifUp(d, i.name))]));
  const domainCache = new Map<string, Endpoint[]>();
  const domain = (d: RtDevice, i: L3If): Endpoint[] => {
    const key = `${d.doc.id}|${i.name}`;
    let v = domainCache.get(key);
    if (!v) {
      v = net.broadcastDomain(d, i.name).filter((e) => e.dev !== d);
      domainCache.set(key, v);
    }
    return v;
  };
  for (const d of routers) res.routes.set(d.doc.id, []);

  // ------------------------------------------------------------------------------ RIP
  type RipEntry = { network: number; mask: number; metric: number; nextHop?: number; iface?: string };
  const ripDb = new Map<string, Map<string, RipEntry>>();
  const ripRouters = routers.filter((d) => d.ios!.rip);
  for (const d of ripRouters) {
    const db = new Map<string, RipEntry>();
    for (const i of upIfs.get(d.doc.id)!) {
      if (!ripEnabled(d.ios!.rip, i)) continue;
      const n = networkOf(i.ip, i.mask);
      db.set(`${n}/${i.mask}`, { network: n, mask: i.mask, metric: 0 });
    }
    if (d.ios!.rip!.defaultOriginate) db.set('0/0', { network: 0, mask: 0, metric: 0 });
    ripDb.set(d.doc.id, db);
  }
  for (let round = 0; round < 16; round++) {
    let changed = false;
    for (const x of ripRouters) {
      const cx = x.ios!.rip!;
      const sendVersion = cx.version ?? 1;
      for (const a of upIfs.get(x.doc.id)!) {
        if (!ripEnabled(cx, a) || cx.passive.includes(a.name)) continue;
        const aMajor = networkOf(a.ip, classfulMask(a.ip));
        // Build the update sent out of interface a (split horizon + summarisation).
        const update = new Map<string, RipEntry>();
        for (const e of ripDb.get(x.doc.id)!.values()) {
          if (e.iface === a.name || e.metric + 1 > 15) continue;
          let { network, mask } = e;
          const major = networkOf(network, classfulMask(network));
          if (mask !== 0 && major !== aMajor && (sendVersion === 1 || cx.autoSummary)) {
            network = major;
            mask = classfulMask(network);
          } else if (sendVersion === 1 && mask !== 0 && mask !== a.mask) continue; // v1 cannot carry other masks
          const k = `${network}/${mask}`;
          const cur = update.get(k);
          if (!cur || e.metric < cur.metric) update.set(k, { network, mask, metric: e.metric });
        }
        for (const nb of domain(x, a)) {
          const y = nb.dev;
          const cy = y.ios?.rip;
          if (!cy || !net.routingEnabled(y) || !ripEnabled(cy, nb.iface)) continue;
          if (networkOf(nb.iface.ip, nb.iface.mask) !== networkOf(a.ip, a.mask)) continue;
          if (cy.version !== undefined && cy.version !== sendVersion) continue;
          const nbs = res.ripNeighbors.get(y.doc.id) ?? [];
          if (!nbs.includes(a.ip)) nbs.push(a.ip);
          res.ripNeighbors.set(y.doc.id, nbs);
          const dbY = ripDb.get(y.doc.id)!;
          for (const [k, e] of update) {
            const cur = dbY.get(k);
            const metric = e.metric + 1;
            if (cur && (cur.metric <= metric || cur.iface === undefined)) continue;
            dbY.set(k, { network: e.network, mask: e.mask, metric, nextHop: a.ip, iface: nb.iface.name });
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  for (const d of ripRouters) {
    const out = res.routes.get(d.doc.id)!;
    for (const e of ripDb.get(d.doc.id)!.values()) {
      if (e.iface === undefined) continue;
      out.push({ type: 'R', network: e.network, mask: e.mask, ad: 120, metric: e.metric, nextHop: e.nextHop!, iface: e.iface, ...(e.mask === 0 ? { candidateDefault: true } : {}) });
    }
  }

  // ------------------------------------------------------------------------------ OSPF
  const ospfRouters = routers.filter((d) => d.ios!.ospf);
  const rid = (d: RtDevice): number => {
    const cfg = d.ios!.ospf!;
    if (cfg.routerId !== undefined) return cfg.routerId;
    const all = net.l3Ifs(d).filter((i) => net.ifUp(d, i.name));
    const lo = all.filter((i) => i.name.startsWith('Loopback')).map((i) => i.ip);
    const pool = lo.length ? lo : all.map((i) => i.ip);
    return pool.length ? Math.max(...pool) : 0;
  };
  for (const d of ospfRouters) res.ospfRouterId.set(d.doc.id, rid(d));
  type Edge = { to: string; cost: number; via: L3If; nhIp: number };
  const edges = new Map<string, Edge[]>();
  for (const x of ospfRouters) {
    const list: Edge[] = [];
    const nbrs: OspfNeighbor[] = [];
    const ridX = res.ospfRouterId.get(x.doc.id)!;
    for (const a of upIfs.get(x.doc.id)!) {
      const area = ospfArea(x, a);
      if (area === undefined || x.ios!.ospf!.passive.includes(a.name) || a.name.startsWith('Loopback')) continue;
      const segment: { dev: RtDevice; iface: L3If; rid: number }[] = [{ dev: x, iface: a, rid: ridX }];
      for (const nb of domain(x, a)) {
        const y = nb.dev;
        if (!y.ios?.ospf || !net.routingEnabled(y)) continue;
        const b = nb.iface;
        if (ospfArea(y, b) !== area || y.ios.ospf.passive.includes(b.name)) continue;
        if (b.mask !== a.mask || networkOf(b.ip, b.mask) !== networkOf(a.ip, a.mask)) continue;
        const ridY = res.ospfRouterId.get(y.doc.id)!;
        if (ridY === ridX) {
          net.console(x.doc.id, `%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${ipToString(ridX)} from ${ipToString(b.ip)} on interface ${a.name}`);
          continue;
        }
        segment.push({ dev: y, iface: b, rid: ridY });
        list.push({ to: y.doc.id, cost: ospfCost(x, a.name), via: a, nhIp: b.ip });
      }
      const p2p = a.name.startsWith('Serial');
      const sorted = [...segment].sort((m, n) => n.rid - m.rid);
      const dr = sorted[0]?.rid;
      const bdr = sorted[1]?.rid;
      for (const s of segment) {
        if (s.dev === x) continue;
        const role = p2p ? '-' : s.rid === dr ? 'DR' : s.rid === bdr ? 'BDR' : 'DROTHER';
        nbrs.push({ routerId: s.rid, address: s.iface.ip, iface: a.name, peerDevice: s.dev.doc.id, state: p2p ? 'FULL/  -' : `FULL/${role}` });
      }
    }
    edges.set(x.doc.id, list);
    res.ospfNeighbors.set(x.doc.id, nbrs);
  }
  // Networks advertised by each router (stub links), loopbacks as /32 like IOS.
  const adverts = new Map<string, { network: number; mask: number; cost: number }[]>();
  for (const y of ospfRouters) {
    const list: { network: number; mask: number; cost: number }[] = [];
    for (const i of upIfs.get(y.doc.id)!) {
      if (ospfArea(y, i) === undefined) continue;
      if (i.name.startsWith('Loopback')) list.push({ network: i.ip, mask: 0xffffffff, cost: 1 });
      else list.push({ network: networkOf(i.ip, i.mask), mask: i.mask, cost: ospfCost(y, i.name) });
    }
    if (y.ios!.ospf!.defaultOriginate && y.ios!.staticRoutes.some((r) => r.mask === 0)) list.push({ network: 0, mask: 0, cost: 1 });
    adverts.set(y.doc.id, list);
  }
  for (const x of ospfRouters) {
    // Dijkstra
    const dist = new Map<string, number>([[x.doc.id, 0]]);
    const first = new Map<string, Edge>();
    const done = new Set<string>();
    for (;;) {
      let u: string | undefined;
      for (const [k, v] of dist) if (!done.has(k) && (u === undefined || v < dist.get(u)! || (v === dist.get(u)! && k < u))) u = k;
      if (u === undefined) break;
      done.add(u);
      for (const e of edges.get(u) ?? []) {
        // Two-way check: the neighbour must also list u.
        if (!(edges.get(e.to) ?? []).some((b) => b.to === u)) continue;
        const nd = dist.get(u)! + e.cost;
        if (!dist.has(e.to) || nd < dist.get(e.to)!) {
          dist.set(e.to, nd);
          first.set(e.to, u === x.doc.id ? e : first.get(u)!);
        }
      }
    }
    const own = new Set(upIfs.get(x.doc.id)!.map((i) => `${networkOf(i.ip, i.mask)}/${i.mask}`));
    const best = new Map<string, Route>();
    for (const [y, dY] of dist) {
      if (y === x.doc.id) continue;
      const hop = first.get(y)!;
      for (const ad of adverts.get(y) ?? []) {
        const k = `${ad.network}/${ad.mask}`;
        if (own.has(k)) continue;
        const metric = dY + (ad.mask === 0 ? 1 : ad.cost);
        const cur = best.get(k);
        if (!cur || metric < cur.metric) {
          best.set(k, { type: 'O', network: ad.network, mask: ad.mask, ad: 110, metric, nextHop: hop.nhIp, iface: hop.via.name, ...(ad.mask === 0 ? { candidateDefault: true, external: true } : {}) });
        }
      }
    }
    res.routes.get(x.doc.id)!.push(...best.values());
  }
  return res;
}
