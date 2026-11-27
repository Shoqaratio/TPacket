/**
 * Deterministic grader. It rebuilds the network from the submitted project (never trusting any
 * client-side state), lets protocols converge, then checks configuration AND behaviour
 * (real packets are sent through the simulator for connectivity criteria).
 */
import { validateProject } from '../model/project';
import type { ProjectDoc } from '../model/types';
import { cidr, maskToPrefix, networkOf, parseCidr, parseIp } from '../net/ipv4';
import { Network, type RtDevice } from '../sim/network';
import { parseIp6 } from '../net/ipv6';
import { ENGINE_VERSION } from '../version';

interface Base {
  id: string;
  points: number;
  /** Must pass for the activity to count as completed. */
  required?: boolean;
  /** Not shown to students before the teacher releases results. */
  hidden?: boolean;
  /** Points only awarded when all listed criteria passed. */
  dependsOn?: string[];
  /** Bonus points may exceed the base total (the final score is capped at maxScore). */
  bonus?: boolean;
  /** A penalty subtracts `points` when its check PASSES (e.g. "a forbidden static route exists"). */
  penalty?: boolean;
  /** Teacher-written explanation shown when the criterion fails. */
  feedback?: string;
}

export type Criterion = Base &
  (
    | { type: 'device_exists'; device: string; model?: string }
    | { type: 'device_count'; model?: string; kind?: string; min?: number; max?: number }
    | { type: 'link_exists'; a: string; b: string; aPort?: string; bPort?: string }
    | { type: 'hostname'; device: string; expected: string }
    | { type: 'interface_address'; device: string; interface: string; expected: string }
    | { type: 'interface_up'; device: string; interface: string }
    | { type: 'host_config'; device: string; field: 'ip' | 'mask' | 'gateway' | 'dns'; expected: string }
    | { type: 'route_exists'; device: string; destination: string; via?: 'static' | 'connected' | 'rip' | 'ospf' | 'any'; nextHop?: string }
    | { type: 'dhcp_client'; device: string }
    | { type: 'service_access'; source: string; destination: string; service: 'http' | 'https' | 'telnet' | 'ssh'; expected: 'allowed' | 'denied' }
    | { type: 'dns_resolution'; source: string; name: string; expected: string }
    | { type: 'ipv6_connectivity'; source: string; destination: string; expected: 'success' | 'failure' }
    | { type: 'connectivity_test'; source: string; destination: string; expected: 'success' | 'failure'; protocol?: 'ICMP' }
    | { type: 'configuration_saved'; device: string }
    | { type: 'vlan_exists'; device: string; vlan: number; name?: string }
    | { type: 'switchport_access'; device: string; interface: string; vlan: number }
    | { type: 'switchport_trunk'; device: string; interface: string }
    | { type: 'enable_secret'; device: string }
    | { type: 'line_password'; device: string; line: 'con' | 'vty'; login?: 'line' | 'local' }
    | { type: 'password_encryption'; device: string }
    | { type: 'acl_applied'; device: string; interface: string; direction: 'in' | 'out'; acl?: string }
  );

export interface Rubric {
  title?: string;
  maxScore: number;
  criteria: Criterion[];
}

export interface CriterionResult {
  id: string;
  type: string;
  passed: boolean;
  skipped: boolean;
  points: number;
  earned: number;
  hidden: boolean;
  required: boolean;
  /** Message code (for translation) and English text. */
  code: string;
  message: string;
  feedback?: string;
}

export interface GradeReport {
  engineVersion: string;
  score: number;
  maxScore: number;
  completed: boolean;
  results: CriterionResult[];
}

type Check = { ok: boolean; code: string; message: string };
const ok = (message: string): Check => ({ ok: true, code: 'ok', message });
const ko = (code: string, message: string): Check => ({ ok: false, code, message });

export const CRITERION_TYPES = [
  'device_exists', 'device_count', 'link_exists', 'hostname', 'interface_address', 'interface_up', 'host_config', 'route_exists',
  'connectivity_test', 'configuration_saved', 'vlan_exists', 'switchport_access', 'switchport_trunk', 'enable_secret',
  'line_password', 'password_encryption', 'acl_applied', 'dhcp_client', 'service_access', 'dns_resolution', 'ipv6_connectivity',
] as const;

function findByName(net: Network, name: string): RtDevice | undefined {
  const lower = name.toLowerCase();
  for (const d of net.devices.values()) if (d.doc.name.toLowerCase() === lower) return d;
  for (const d of net.devices.values()) if (d.ios?.hostname.toLowerCase() === lower) return d;
  return undefined;
}

function canonIf(d: RtDevice, name: string): string {
  const n = name.replace(/\s+/g, '');
  const m = /^([a-zA-Z-]+)(\d.*)$/.exec(n);
  if (!m) return name;
  const types = ['GigabitEthernet', 'FastEthernet', 'Serial', 'Vlan', 'Loopback', 'Ethernet'];
  const t = types.find((x) => x.toLowerCase().startsWith(m[1]!.toLowerCase()));
  const full = t ? t + m[2] : name;
  return d.ports.has(full.split('.')[0]!) || d.ios?.interfaces.has(full) ? full : name;
}

function targetIp(net: Network, s: string): number | null {
  const ip = parseIp(s);
  if (ip !== null) return ip;
  const d = findByName(net, s);
  if (!d) return null;
  const i = net.l3Ifs(d)[0];
  return i ? i.ip : null;
}

function evaluate(net: Network, c: Criterion): Check {
  const need = (name: string): RtDevice | Check => findByName(net, name) ?? ko('device_missing', `Device ${name} not found`);
  const isCheck = (x: RtDevice | Check): x is Check => 'ok' in x;
  switch (c.type) {
    case 'device_exists': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      if (c.model && d.doc.model !== c.model) return ko('wrong_model', `${c.device} is a ${d.doc.model}, expected ${c.model}`);
      return ok(`${c.device} present`);
    }
    case 'device_count': {
      const n = [...net.devices.values()].filter((d) => (!c.model || d.doc.model === c.model) && (!c.kind || d.kind === c.kind)).length;
      if (c.min !== undefined && n < c.min) return ko('too_few', `${n} device(s), at least ${c.min} expected`);
      if (c.max !== undefined && n > c.max) return ko('too_many', `${n} device(s), at most ${c.max} expected`);
      return ok(`${n} device(s)`);
    }
    case 'link_exists': {
      const a = need(c.a);
      const b = need(c.b);
      if (isCheck(a)) return a;
      if (isCheck(b)) return b;
      const l = net.doc.links.find((x) =>
        (x.a.device === a.doc.id && x.b.device === b.doc.id && (!c.aPort || x.a.port === canonIf(a, c.aPort)) && (!c.bPort || x.b.port === canonIf(b, c.bPort))) ||
        (x.b.device === a.doc.id && x.a.device === b.doc.id && (!c.aPort || x.b.port === canonIf(a, c.aPort)) && (!c.bPort || x.a.port === canonIf(b, c.bPort))),
      );
      if (!l) return ko('link_missing', `No cable between ${c.a} and ${c.b}`);
      const end = l.a.device === a.doc.id ? l.a : l.b;
      if (!net.portStatus(a.doc.id, end.port).l1) return ko('link_down', `The cable between ${c.a} and ${c.b} is not operational (cable type or port state)`);
      return ok('Link present and operational');
    }
    case 'hostname': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const h = d.hostname();
      return h === c.expected ? ok(`hostname ${h}`) : ko('hostname', `Hostname is "${h}", expected "${c.expected}"`);
    }
    case 'interface_address': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const want = parseCidr(c.expected);
      if (!want) return ko('rubric_error', `Invalid expected address ${c.expected}`);
      const ifn = canonIf(d, c.interface);
      const got = d.host ? (d.host.ip ? { address: parseIp(d.host.ip)!, mask: parseIp(d.host.mask) ?? 0 } : undefined) : d.ios?.interfaces.get(ifn)?.ip;
      if (!got) return ko('no_address', `${c.device} ${ifn} has no IP address`);
      if (got.address !== want.ip || got.mask !== want.mask) return ko('wrong_address', `${c.device} ${ifn} is ${ipStr(got.address)}/${maskToPrefix(got.mask)}, expected ${c.expected}`);
      return ok(`${ifn} ${c.expected}`);
    }
    case 'interface_up': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const ifn = canonIf(d, c.interface);
      const st = d.ios ? net.ifStatus(d, ifn) : net.portStatus(d.doc.id, ifn);
      if (st.adminDown) return ko('admin_down', `${c.device} ${ifn} is administratively down`);
      if (!st.proto) return ko('down', `${c.device} ${ifn} is down`);
      return ok(`${ifn} up/up`);
    }
    case 'host_config': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      if (!d.host) return ko('not_host', `${c.device} is not an end device`);
      const v = d.host[c.field];
      return v === c.expected ? ok(`${c.field} ${v}`) : ko('host_config', `${c.device} ${c.field} is "${v || 'empty'}", expected ${c.expected}`);
    }
    case 'route_exists': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const want = parseCidr(c.destination);
      if (!want) return ko('rubric_error', `Invalid destination ${c.destination}`);
      const nh = c.nextHop ? parseIp(c.nextHop) : null;
      const routes = net.routes(d).filter((r) => r.network === networkOf(want.ip, want.mask) && r.mask === want.mask);
      const viaCode = { static: 'S', connected: 'C', rip: 'R', ospf: 'O' } as const;
      const match = routes.find((r) => (!c.via || c.via === 'any' || r.type === viaCode[c.via]) && (nh === null || r.nextHop === nh));
      return match ? ok(`Route ${c.destination} installed`) : ko('route_missing', `${c.device} has no ${c.via && c.via !== 'any' ? c.via + ' ' : ''}route to ${c.destination} in its routing table`);
    }
    case 'connectivity_test': {
      const src = need(c.source);
      if (isCheck(src)) return src;
      const dst = targetIp(net, c.destination);
      if (dst === null) return ko('device_missing', `No address for ${c.destination}`);
      let replies = 0;
      for (let k = 0; k < 6; k++) if (net.echo(src.doc.id, dst, { timeout: 2000 }).kind === 'reply') replies++;
      const success = replies > 0;
      if (c.expected === 'success') return success ? ok(`${c.source} reaches ${c.destination} (${replies}/4)`) : ko('unreachable', `${c.source} cannot reach ${c.destination}`);
      return success ? ko('not_isolated', `${c.source} can reach ${c.destination} but must not`) : ok(`${c.source} cannot reach ${c.destination}, as required`);
    }
    case 'configuration_saved': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      if (!d.ios) return ko('not_ios', `${c.device} has no IOS configuration`);
      if (!d.doc.startup) return ko('not_saved', `${c.device}: startup-config is empty (copy running-config startup-config)`);
      return d.doc.startup === net.runningConfig(d) ? ok('running-config saved') : ko('not_saved', `${c.device}: running-config has unsaved changes`);
    }
    case 'vlan_exists': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const v = net.allVlans(d).find((x) => x.id === c.vlan);
      if (!v) return ko('vlan_missing', `VLAN ${c.vlan} does not exist on ${c.device}`);
      if (c.name && v.name.toLowerCase() !== c.name.toLowerCase()) return ko('vlan_name', `VLAN ${c.vlan} is named "${v.name}", expected "${c.name}"`);
      return ok(`VLAN ${c.vlan} exists`);
    }
    case 'switchport_access': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const ifn = canonIf(d, c.interface);
      const i = d.ios?.interfaces.get(ifn);
      if (!i?.switchport) return ko('not_switchport', `${c.device} ${ifn} is not a switch port`);
      if (net.isTrunk(d, ifn)) return ko('is_trunk', `${c.device} ${ifn} is trunking`);
      return i.accessVlan === c.vlan ? ok(`${ifn} in VLAN ${c.vlan}`) : ko('wrong_vlan', `${c.device} ${ifn} is in VLAN ${i.accessVlan}, expected ${c.vlan}`);
    }
    case 'switchport_trunk': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const ifn = canonIf(d, c.interface);
      return net.isTrunk(d, ifn) && net.portStatus(d.doc.id, ifn).proto ? ok(`${ifn} trunking`) : ko('not_trunk', `${c.device} ${ifn} is not an operational trunk`);
    }
    case 'enable_secret': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      return d.ios?.enableSecret ? ok('enable secret set') : ko('no_secret', `${c.device} has no enable secret`);
    }
    case 'line_password': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const l = c.line === 'con' ? d.ios?.con : d.ios?.vty;
      if (!l) return ko('not_ios', `${c.device} has no IOS lines`);
      const want = c.login ?? 'line';
      if (l.login !== want) return ko('no_login', `line ${c.line}: "login${want === 'local' ? ' local' : ''}" is not configured`);
      if (want === 'line' && l.password === undefined) return ko('no_password', `line ${c.line} has no password`);
      if (want === 'local' && !d.ios!.users.length) return ko('no_users', `${c.device} has no local user`);
      return ok(`line ${c.line} protected`);
    }
    case 'password_encryption': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      return d.ios?.servicePasswordEncryption ? ok('service password-encryption') : ko('no_encryption', `${c.device}: service password-encryption is not enabled`);
    }
    case 'dhcp_client': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      if (!d.host) return ko('not_host', `${c.device} is not an end device`);
      const r = net.dhcpRenew(d.doc.id);
      return r.ok ? ok(`${c.device} obtained ${r.ip} by DHCP`) : ko('dhcp_failed', `${c.device} did not obtain an address by DHCP`);
    }
    case 'service_access': {
      const src = need(c.source);
      if (isCheck(src)) return src;
      const dst = targetIp(net, c.destination);
      if (dst === null) return ko('device_missing', `No address for ${c.destination}`);
      const port = { http: 80, https: 443, telnet: 23, ssh: 22 }[c.service];
      const data = c.service === 'http' || c.service === 'https' ? ({ app: 'http', method: 'GET', path: '/' } as const) : ({ app: 'vty', proto: c.service } as const);
      const o = net.tcpTransaction(src.doc.id, dst, port, data);
      const allowed = o.kind === 'data';
      if (c.expected === 'allowed') return allowed ? ok(`${c.service} reachable`) : ko('service_blocked', `${c.source} cannot open ${c.service} to ${c.destination}`);
      return allowed ? ko('service_open', `${c.service} from ${c.source} to ${c.destination} must be denied`) : ok(`${c.service} denied as required`);
    }
    case 'dns_resolution': {
      const src = need(c.source);
      if (isCheck(src)) return src;
      const r = net.resolveName(src.doc.id, c.name);
      if (r.ip === undefined) return ko('dns_failed', `${c.source} cannot resolve ${c.name} (${r.error})`);
      return ipStr(r.ip) === c.expected ? ok(`${c.name} -> ${c.expected}`) : ko('dns_wrong', `${c.name} resolves to ${ipStr(r.ip)}, expected ${c.expected}`);
    }
    case 'ipv6_connectivity': {
      const src = need(c.source);
      if (isCheck(src)) return src;
      let dst = parseIp6(c.destination);
      if (dst === null) {
        const d = findByName(net, c.destination);
        const i = d ? net.l3Ifs6(d)[0] : undefined;
        dst = i?.addrs[0]?.ip ?? null;
      }
      if (dst === null) return ko('device_missing', `No IPv6 address for ${c.destination}`);
      let replies = 0;
      for (let k = 0; k < 4; k++) if (net.echo6(src.doc.id, dst).kind === 'reply') replies++;
      const success = replies > 0;
      if (c.expected === 'success') return success ? ok(`IPv6 ${c.source} reaches ${c.destination}`) : ko('unreachable', `${c.source} cannot reach ${c.destination} over IPv6`);
      return success ? ko('not_isolated', `${c.source} reaches ${c.destination} over IPv6 but must not`) : ok('IPv6 isolation respected');
    }
    case 'acl_applied': {
      const d = need(c.device);
      if (isCheck(d)) return d;
      const ifn = canonIf(d, c.interface);
      const i = d.ios?.interfaces.get(ifn);
      const got = c.direction === 'in' ? i?.aclIn : i?.aclOut;
      if (!got) return ko('acl_missing', `No ACL applied ${c.direction} on ${c.device} ${ifn}`);
      if (c.acl && got !== c.acl) return ko('wrong_acl', `ACL ${got} applied, expected ${c.acl}`);
      if (!d.ios!.acls.has(got)) return ko('acl_undefined', `ACL ${got} is applied but not defined`);
      return ok(`ACL ${got} ${c.direction} on ${ifn}`);
    }
  }
}

function ipStr(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function validateRubric(input: unknown): Rubric {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid rubric');
  const r = input as Record<string, unknown>;
  if (typeof r.maxScore !== 'number' || r.maxScore <= 0 || r.maxScore > 1000) throw new Error('Invalid maxScore');
  if (!Array.isArray(r.criteria) || r.criteria.length > 200) throw new Error('Invalid criteria');
  const ids = new Set<string>();
  for (const c of r.criteria as Record<string, unknown>[]) {
    if (typeof c !== 'object' || !c || typeof c.id !== 'string' || !(CRITERION_TYPES as readonly string[]).includes(c.type as string)) throw new Error(`Invalid criterion ${String(c?.id)}`);
    if (typeof c.points !== 'number' || c.points < 0 || c.points > 1000) throw new Error(`Invalid points for ${c.id}`);
    if (ids.has(c.id)) throw new Error(`Duplicate criterion id ${c.id}`);
    if (c.dependsOn !== undefined && (!Array.isArray(c.dependsOn) || c.dependsOn.some((d) => typeof d !== 'string'))) {
      throw new Error(`Invalid dependsOn for ${c.id}`);
    }
    ids.add(c.id);
  }
  return input as Rubric;
}

/**
 * Message of a criterion skipped because of unmet dependencies. Hidden criteria are only counted:
 * their ids must never reach a student through a visible criterion.
 */
export function requiresMessage(blocked: string[], hiddenIds: ReadonlySet<string>): string {
  const visible = blocked.filter((d) => !hiddenIds.has(d));
  const n = blocked.length - visible.length;
  const hidden = n === 1 ? '1 hidden criterion' : `${n} hidden criteria`;
  if (!visible.length) return `Requires: ${hidden}`;
  return `Requires: ${visible.join(', ')}${n ? ` (+${hidden})` : ''}`;
}

export function grade(projectInput: unknown, rubricInput: unknown): GradeReport {
  const rubric = validateRubric(rubricInput);
  const project: ProjectDoc = validateProject(structuredClone(projectInput));
  const net = new Network(project);
  net.converge();
  const results: CriterionResult[] = [];
  const passed = new Set<string>();
  const hiddenIds = new Set(rubric.criteria.filter((c) => c.hidden).map((c) => c.id));
  for (const c of rubric.criteria) {
    const deps = c.dependsOn ?? [];
    const blocked = deps.filter((d) => !passed.has(d));
    let check: Check;
    let skipped = false;
    if (blocked.length) {
      check = ko('dependency', requiresMessage(blocked, hiddenIds));
      skipped = true;
    } else {
      try {
        check = evaluate(net, c);
      } catch (e) {
        check = ko('error', `Evaluation error: ${(e as Error).message}`);
      }
    }
    // For a penalty, the check detects a forbidden situation: the STUDENT succeeds when it does not
    // match. Every downstream decision (dependencies, feedback, completion) uses this single value.
    // A penalty skipped because of a dependency is neither applied nor counted as satisfied.
    const succeeded = skipped ? false : c.penalty ? !check.ok : check.ok;
    if (succeeded) passed.add(c.id);
    const earned = c.penalty ? (!skipped && check.ok ? -c.points : 0) : succeeded ? c.points : 0;
    results.push({
      id: c.id,
      type: c.type,
      passed: succeeded,
      skipped,
      points: c.points,
      earned,
      hidden: !!c.hidden,
      required: !!c.required,
      code: check.code,
      message: check.message,
      ...(!succeeded && c.feedback ? { feedback: c.feedback } : {}),
    });
  }
  const raw = results.reduce((s, r) => s + r.earned, 0);
  const score = Math.round(Math.max(0, Math.min(rubric.maxScore, raw)) * 100) / 100;
  const completed = rubric.criteria.every((c) => !c.required || passed.has(c.id));
  return { engineVersion: ENGINE_VERSION, score, maxScore: rubric.maxScore, completed, results };
}
