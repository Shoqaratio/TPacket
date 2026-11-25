/**
 * Generic IOS-style command parser: a trie of keyword / parameter nodes with
 * unique-prefix abbreviation, contextual `?` help, TAB completion and caret error positions.
 */
import { parseIp } from '../net/ipv4';
import { IF_TYPES } from './config';

export type ParamKind = 'ip' | 'word' | 'line' | 'iface' | 'range' | 'hex';

interface BaseNode<C> {
  help: string;
  children: Node<C>[];
  run?: Handler<C>;
  hidden?: boolean;
}
export interface KwNode<C> extends BaseNode<C> {
  kind: 'kw';
  word: string;
}
export interface ParamNode<C> extends BaseNode<C> {
  kind: 'param';
  p: ParamKind;
  label: string;
  lo?: number;
  hi?: number;
}
export type Node<C> = KwNode<C> | ParamNode<C>;

export interface Args {
  /** Parameter values, in order. */
  p: string[];
  /** Canonical keywords that were matched, in order. */
  kw: string[];
  has(word: string): boolean;
}
export type Handler<C> = (ctx: C, a: Args) => void;

export interface Tree<C> {
  children: Node<C>[];
}

export function newTree<C>(): Tree<C> {
  return { children: [] };
}

const PARAM_ORDER: Record<ParamKind, number> = { ip: 0, range: 1, hex: 2, iface: 3, word: 4, line: 5 };

function parseSyntaxToken<C>(t: string, help: string): Omit<KwNode<C>, 'children'> | Omit<ParamNode<C>, 'children'> {
  const m = /^<(.+)>$/.exec(t);
  if (!m) return { kind: 'kw', word: t, help };
  const inner = m[1]!;
  const r = /^(\d+)-(\d+)$/.exec(inner);
  if (r) return { kind: 'param', p: 'range', label: `<${inner}>`, lo: Number(r[1]), hi: Number(r[2]), help };
  switch (inner) {
    case 'ip':
      return { kind: 'param', p: 'ip', label: 'A.B.C.D', help };
    case 'line':
      return { kind: 'param', p: 'line', label: 'LINE', help };
    case 'iface':
      return { kind: 'param', p: 'iface', label: 'IFACE', help };
    case 'hex':
      return { kind: 'param', p: 'hex', label: 'Hex-string', help };
    default:
      return { kind: 'param', p: 'word', label: inner === 'word' ? 'WORD' : inner, help };
  }
}

function sameTok<C>(n: Node<C>, t: ReturnType<typeof parseSyntaxToken<C>>): boolean {
  if (n.kind !== t.kind) return false;
  if (n.kind === 'kw') return n.word === (t as KwNode<C>).word;
  const tp = t as ParamNode<C>;
  return n.p === tp.p && n.lo === tp.lo && n.hi === tp.hi && n.label === tp.label;
}

/**
 * Registers a command. `syntax` is space separated: literal keywords, `<ip>`, `<1-4094>`,
 * `<word>` / `<WORD-label>`, `<line>` (rest of line), `<iface>`, `<hex>`.
 * `helps` gives help strings per token position (missing entries fall back to the HELP dictionary).
 */
export function def<C>(tree: Tree<C>, syntax: string, run: Handler<C>, helps: string[] = [], opts: { hidden?: boolean } = {}): void {
  let level = tree.children;
  let node: Node<C> | undefined;
  syntax.split(' ').forEach((t, i) => {
    const help = helps[i] ?? HELP[t] ?? '';
    const tok = parseSyntaxToken<C>(t, help);
    node = level.find((n) => sameTok(n, tok));
    if (!node) {
      node = { ...tok, children: [] } as Node<C>;
      if (opts.hidden) node.hidden = true;
      level.push(node);
    } else if (!node.help && help) node.help = help;
    level = node.children;
  });
  node!.run = run;
}

export interface Token {
  text: string;
  start: number;
}

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}

export type MatchResult<C> =
  | { ok: true; run: Handler<C>; args: Args; node: Node<C> | Tree<C> }
  | { ok: false; error: 'invalid' | 'incomplete' | 'ambiguous'; at: number; token?: string };

const IFNUM = /^\d+(\/\d+){0,2}(\.\d+)?$/;

/** Resolves an interface type abbreviation ("g", "fa", "se") to the canonical type name. */
export function resolveIfType(prefix: string): string | null {
  const p = prefix.toLowerCase();
  const hits = IF_TYPES.filter((t) => t.toLowerCase().startsWith(p));
  if (hits.length === 1) return hits[0]!;
  const exact = IF_TYPES.find((t) => t.toLowerCase() === p);
  if (exact) return exact;
  // IOS resolves the ambiguous "f"/"e" by priority.
  if (p === 'f') return 'FastEthernet';
  if (p === 'e') return 'Ethernet';
  return null;
}

/** Tries to read an interface reference at tokens[i]; returns [canonicalName, tokensConsumed]. */
export function readIface(tokens: Token[], i: number): [string, number] | null {
  const t = tokens[i]?.text;
  if (!t) return null;
  const joined = /^([a-zA-Z-]+)(\d.*)$/.exec(t);
  if (joined && IFNUM.test(joined[2]!)) {
    const type = resolveIfType(joined[1]!);
    if (type) return [type + joined[2], 1];
  }
  if (/^[a-zA-Z-]+$/.test(t)) {
    const type = resolveIfType(t);
    const n = tokens[i + 1]?.text;
    if (type && n && IFNUM.test(n)) return [type + n, 2];
  }
  return null;
}

function paramAccepts<C>(n: ParamNode<C>, tok: string): boolean {
  switch (n.p) {
    case 'ip':
      return parseIp(tok) !== null;
    case 'range': {
      if (!/^\d+$/.test(tok)) return false;
      const v = Number(tok);
      return v >= n.lo! && v <= n.hi!;
    }
    case 'hex':
      return /^[0-9a-fA-F]+$/.test(tok);
    default:
      return true;
  }
}

function makeArgs(p: string[], kw: string[]): Args {
  return { p, kw, has: (w) => kw.includes(w) };
}

interface Candidate<C> {
  node: Node<C>;
  consumed: number;
  value?: string;
}

function candidates<C>(children: Node<C>[], tokens: Token[], i: number, line: string): Candidate<C>[] | 'ambiguous' {
  const tok = tokens[i]!.text;
  const lower = tok.toLowerCase();
  const kws = children.filter((c): c is KwNode<C> => c.kind === 'kw');
  const exact = kws.find((k) => k.word.toLowerCase() === lower);
  const out: Candidate<C>[] = [];
  if (exact) out.push({ node: exact, consumed: 1 });
  else {
    const prefix = kws.filter((k) => !k.hidden && k.word.toLowerCase().startsWith(lower));
    if (prefix.length > 1) return 'ambiguous';
    if (prefix.length === 1) out.push({ node: prefix[0]!, consumed: 1 });
  }
  const params = children.filter((c): c is ParamNode<C> => c.kind === 'param').sort((a, b) => PARAM_ORDER[a.p] - PARAM_ORDER[b.p]);
  for (const pn of params) {
    if (pn.p === 'iface') {
      const r = readIface(tokens, i);
      if (r) out.push({ node: pn, consumed: r[1], value: r[0] });
    } else if (pn.p === 'line') {
      out.push({ node: pn, consumed: tokens.length - i, value: line.slice(tokens[i]!.start).trimEnd() });
    } else if (paramAccepts(pn, tok)) out.push({ node: pn, consumed: 1, value: tok });
  }
  return out;
}

export function match<C>(tree: Tree<C>, line: string): MatchResult<C> {
  const tokens = tokenize(line);
  const walk = (children: Node<C>[], self: Node<C> | Tree<C>, i: number, p: string[], kw: string[]): MatchResult<C> => {
    if (i >= tokens.length) {
      const run = 'run' in self ? self.run : undefined;
      if (run) return { ok: true, run, args: makeArgs(p, kw), node: self };
      return { ok: false, error: 'incomplete', at: i };
    }
    const cands = candidates(children, tokens, i, line);
    if (cands === 'ambiguous') return { ok: false, error: 'ambiguous', at: i, token: tokens[i]!.text };
    let fail: MatchResult<C> = { ok: false, error: 'invalid', at: i };
    for (const c of cands) {
      const np = c.node.kind === 'param' ? [...p, c.value!] : p;
      const nk = c.node.kind === 'kw' ? [...kw, c.node.word] : kw;
      const r = walk(c.node.children, c.node, i + c.consumed, np, nk);
      if (r.ok) return r;
      if (r.at > (fail as { at: number }).at || (r.at === (fail as { at: number }).at && fail.ok === false && fail.error === 'invalid')) fail = r;
    }
    return fail;
  };
  return walk(tree.children, tree, 0, [], []);
}

export interface HelpEntry {
  word: string;
  help: string;
}

/** Contextual help for a line ending in `?`. Returns null if the prefix itself is invalid. */
export function help<C>(tree: Tree<C>, lineBeforeQ: string): { entries: HelpEntry[]; partial: boolean } | { error: MatchResult<C> } {
  const partial = lineBeforeQ.length > 0 && !/\s$/.test(lineBeforeQ);
  const tokens = tokenize(lineBeforeQ);
  const fixed = partial ? tokens.slice(0, -1) : tokens;
  const word = partial ? tokens[tokens.length - 1]!.text.toLowerCase() : '';
  // Walk the fixed tokens.
  let level: Node<C>[] = tree.children;
  let self: Node<C> | Tree<C> = tree;
  let i = 0;
  while (i < fixed.length) {
    const cands = candidates(level, fixed, i, lineBeforeQ);
    if (cands === 'ambiguous') return { error: { ok: false, error: 'ambiguous', at: i, token: fixed[i]!.text } };
    const c = cands[0];
    if (!c) return { error: { ok: false, error: 'invalid', at: i } };
    if (c.node.kind === 'param' && c.node.p === 'line') return { entries: [{ word: 'LINE', help: c.node.help }, { word: '<cr>', help: '' }], partial: false };
    self = c.node;
    level = c.node.children;
    i += c.consumed;
  }
  const entries: HelpEntry[] = [];
  if (partial) {
    for (const n of level) if (n.kind === 'kw' && !n.hidden && n.word.toLowerCase().startsWith(word)) entries.push({ word: n.word, help: n.help });
    // Interface types are completed like keywords.
    for (const n of level) if (n.kind === 'param' && n.p === 'iface') for (const t of IF_TYPES) if (t.toLowerCase().startsWith(word)) entries.push({ word: t, help: `${t} IEEE 802.3` });
    entries.sort((a, b) => a.word.localeCompare(b.word));
    return { entries, partial: true };
  }
  const kws = level.filter((n): n is KwNode<C> => n.kind === 'kw' && !n.hidden).sort((a, b) => a.word.localeCompare(b.word));
  for (const n of kws) entries.push({ word: n.word, help: n.help });
  for (const n of level) {
    if (n.kind !== 'param') continue;
    if (n.p === 'iface') for (const t of IF_TYPES) entries.push({ word: t, help: IF_HELP[t] ?? '' });
    else entries.push({ word: n.label, help: n.help });
  }
  if ('run' in self && self.run) entries.push({ word: '<cr>', help: '' });
  return { entries, partial: false };
}

/** TAB completion: returns the completed line, or null if the last word is not a unique keyword prefix. */
export function complete<C>(tree: Tree<C>, line: string): string | null {
  if (/\s$/.test(line) || !line.trim()) return null;
  const tokens = tokenize(line);
  const last = tokens[tokens.length - 1]!;
  const h = help(tree, line);
  if ('error' in h) return null;
  const kws = h.entries.filter((e) => e.word !== '<cr>');
  const lower = last.text.toLowerCase();
  const exact = kws.find((e) => e.word.toLowerCase() === lower);
  const pick = exact ?? (kws.length === 1 ? kws[0] : undefined);
  if (!pick) return null;
  return line.slice(0, last.start) + pick.word + ' ';
}

export const IF_HELP: Record<string, string> = {
  Ethernet: 'IEEE 802.3',
  FastEthernet: 'FastEthernet IEEE 802.3',
  GigabitEthernet: 'GigabitEthernet IEEE 802.3z',
  Serial: 'Serial',
  Vlan: 'Catalyst Vlans',
  Loopback: 'Loopback interface',
};

/** Default help strings, close to IOS wording. */
export const HELP: Record<string, string> = {
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  exit: 'Exit from the EXEC',
  logout: 'Exit from the EXEC',
  end: 'Exit from configure mode',
  configure: 'Enter configuration mode',
  terminal: 'Configure from the terminal',
  show: 'Show running system information',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  copy: 'Copy from one file to another',
  write: 'Write running configuration to memory, network, or terminal',
  memory: 'Write to NV memory',
  erase: 'Erase a filesystem',
  reload: 'Halt and perform a cold restart',
  clock: 'Manage the system clock',
  hostname: 'Set system\'s network name',
  interface: 'Select an interface to configure',
  range: 'interface range command',
  description: 'Interface specific description',
  ip: 'Global IP configuration subcommands',
  address: 'Set the IP address of an interface',
  shutdown: 'Shutdown the selected interface',
  no: 'Negate a command or set its defaults',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  brief: 'Brief summary of IP status and configuration',
  interfaces: 'Interface status and configuration',
  route: 'IP routing table',
  arp: 'ARP table',
  'mac-address-table': 'MAC forwarding table',
  'mac': 'MAC configuration',
  'address-table': 'MAC forwarding table',
  vlan: 'Vlan commands',
  trunk: 'Show interface trunk information',
  cdp: 'CDP information',
  neighbors: 'CDP neighbor entries',
  'spanning-tree': 'Spanning tree topology',
  'access-lists': 'List access lists',
  'access-list': 'Add an access list entry',
  version: 'System hardware and software status',
  history: 'Display the session command history',
  name: 'Ascii name of the VLAN',
  switchport: 'Set switching mode characteristics',
  mode: 'Set trunking mode of the interface',
  access: 'Set access mode characteristics of the interface',
  encapsulation: 'Set encapsulation type for an interface',
  dot1Q: 'IEEE 802.1Q Virtual LAN',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  routing: 'Enable IP routing',
  'access-group': 'Specify access control for packets',
  secret: 'Assign the privileged level secret',
  password: 'Set a password',
  service: 'Modify use of network based services',
  'password-encryption': 'Encrypt system passwords',
  line: 'Configure a terminal line',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  login: 'Enable password checking',
  local: 'Local password checking',
  username: 'Establish User Name Authentication',
  transport: 'Define transport protocols for line',
  input: 'Define which protocols to use when connecting to the terminal server',
  ssh: 'Configure ssh options',
  telnet: 'TCP/IP Telnet protocol',
  'domain-name': 'Define the default domain name',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  crypto: 'Encryption module',
  key: 'Long term key operations',
  generate: 'Generate new keys',
  rsa: 'Generate RSA keys',
  banner: 'Define a login banner',
  motd: 'Set Message of the Day banner',
  rate: 'Configure serial interface clock speed',
  do: 'To run exec commands in config mode',
  dynamic: 'Set trunking mode to dynamically negotiate access or trunk mode',
  auto: 'Set trunking mode dynamic negotiation parameter to AUTO',
  desirable: 'Set trunking mode dynamic negotiation parameter to DESIRABLE',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  native: 'Set trunking native characteristics when interface is in trunking mode',
  permit: 'Specify packets to forward',
  deny: 'Specify packets to reject',
  any: 'Any source host',
  host: 'A single host address',
  eq: 'Match only packets on a given port number',
  in: 'inbound packets',
  out: 'outbound packets',
  icmp: 'Internet Control Message Protocol',
  tcp: 'Transmission Control Protocol',
  udp: 'User Datagram Protocol',
  portfast: 'Spanning tree portfast options',
  priority: 'Set the bridge priority for the spanning tree',
  speed: 'Configure speed operation.',
  duplex: 'Configure duplex operation.',
  'proxy-arp': 'Enable proxy ARP',
  'exec-timeout': 'Set the EXEC timeout',
  logging: 'Modify message logging facilities',
  synchronous: 'Synchronized message output',
  privilege: 'Set user privilege level',
  set: 'Set the time and date',
  length: 'Set number of lines on a screen',
  run: 'Enable CDP',
  dhcp: 'Show items in the DHCP database',
  static: 'Static addresses',
};
