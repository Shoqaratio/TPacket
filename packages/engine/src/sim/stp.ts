/**
 * IEEE 802.1D spanning-tree computation, run per VLAN (Cisco PVST+).
 * The tree is computed from the current topology (the result BPDU exchange converges to);
 * the listening/learning timers are applied by the Network using the role-change timestamps.
 */

export type StpRole = 'root' | 'designated' | 'alternate';

export interface StpBridge {
  id: string;
  /** priority + vlan (sys-id-ext) */
  priority: number;
  mac: string;
  ports: { name: string; index: number; cost: number; segment: string }[];
}

export interface StpResult {
  rootOf: Map<string, string>; // bridge -> root bridge id
  rootCost: Map<string, number>;
  rootPort: Map<string, string>;
  roles: Map<string, StpRole>; // `${bridge}|${port}`
}

const cmpBid = (a: StpBridge, b: StpBridge) => a.priority - b.priority || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0);

export function portCost(speedMbps: number): number {
  if (speedMbps >= 1000) return 4;
  if (speedMbps >= 100) return 19;
  return 100;
}

export function computeStp(bridges: StpBridge[]): StpResult {
  const res: StpResult = { rootOf: new Map(), rootCost: new Map(), rootPort: new Map(), roles: new Map() };
  const segMembers = new Map<string, { bridge: StpBridge; port: StpBridge['ports'][number] }[]>();
  for (const b of bridges) for (const p of b.ports) {
    const list = segMembers.get(p.segment) ?? [];
    list.push({ bridge: b, port: p });
    segMembers.set(p.segment, list);
  }
  // Best received vector per bridge: [cost, designatedBridge, designatedPortIndex, ownPortIndex].
  type Vec = { cost: number; dBridge: StpBridge; dPort: number; port: StpBridge['ports'][number] };
  const better = (a: Vec, b: Vec) =>
    a.cost - b.cost || cmpBid(a.dBridge, b.dBridge) || a.dPort - b.dPort || a.port.index - b.port.index;

  const sorted = [...bridges].sort(cmpBid);
  for (const root of sorted) {
    if (res.rootOf.has(root.id)) continue;
    res.rootOf.set(root.id, root.id);
    res.rootCost.set(root.id, 0);
    const best = new Map<string, Vec>();
    const done = new Set<string>();
    const frontier: StpBridge[] = [root];
    const costOf = (b: StpBridge) => res.rootCost.get(b.id)!;
    while (frontier.length) {
      frontier.sort((a, b) => costOf(a) - costOf(b) || cmpBid(a, b));
      const x = frontier.shift()!;
      if (done.has(x.id)) continue;
      done.add(x.id);
      for (const px of x.ports) {
        for (const m of segMembers.get(px.segment) ?? []) {
          const y = m.bridge;
          if (y.id === x.id || done.has(y.id)) continue;
          const cand: Vec = { cost: costOf(x) + m.port.cost, dBridge: x, dPort: px.index, port: m.port };
          const cur = best.get(y.id);
          if (!cur || better(cand, cur) < 0) {
            best.set(y.id, cand);
            res.rootCost.set(y.id, cand.cost);
            res.rootOf.set(y.id, root.id);
            res.rootPort.set(y.id, cand.port.name);
            frontier.push(y);
          }
        }
      }
    }
  }
  // Designated port per segment.
  for (const [, members] of segMembers) {
    let des: (typeof members)[number] | undefined;
    for (const m of members) {
      if (!des) { des = m; continue; }
      const a = res.rootCost.get(m.bridge.id)!;
      const b = res.rootCost.get(des.bridge.id)!;
      const d = a - b || cmpBid(m.bridge, des.bridge) || m.port.index - des.port.index;
      if (d < 0) des = m;
    }
    for (const m of members) {
      const key = `${m.bridge.id}|${m.port.name}`;
      if (m === des) res.roles.set(key, 'designated');
      else if (res.rootPort.get(m.bridge.id) === m.port.name) res.roles.set(key, 'root');
      else res.roles.set(key, 'alternate');
    }
  }
  return res;
}
