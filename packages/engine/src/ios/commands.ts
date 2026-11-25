import type { DeviceKind } from '../model/types';
import { ipToString, isUsableHost, maskToPrefix, networkOf, parseIp } from '../net/ipv4';
import type { EchoOutcome } from '../sim/network';
import { saltFrom, type5Hash, type7Decode } from '../util/secrets';
import { type AclEntry, type AclProto, newInterface, parseVlanList, type SwitchportMode } from './config';
import { replay } from './load';
import { type Args, def, newTree, readIface, tokenize, type Tree } from './parser';
import type { Ctx, Mode } from './session';
import * as show from './show';
import { defineL3 } from './commands-l3';
import { ip6ToString, parseIp6 } from '../net/ipv6';

type T = Tree<Ctx>;
type H = (ctx: Ctx, a: Args) => void;

const VALID_CLOCK_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 128000, 148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000];
const PORT_NAMES: Record<string, number> = { www: 80, http: 80, telnet: 23, ftp: 21, 'ftp-data': 20, smtp: 25, domain: 53, pop3: 110, tftp: 69, ntp: 123, bootps: 67, bootpc: 68, snmp: 161 };
const PORT_LABEL: Record<number, string> = { 80: 'www', 23: 'telnet', 21: 'ftp', 25: 'smtp', 53: 'domain', 110: 'pop3', 69: 'tftp', 123: 'ntp' };
export { PORT_LABEL };

const cache = new Map<DeviceKind, Record<Mode, T>>();

export function treesFor(kind: DeviceKind): Record<Mode, T> {
  let t = cache.get(kind);
  if (!t) {
    t = build(kind);
    cache.set(kind, t);
  }
  return t;
}

// =============================================================================================
// Helpers
// =============================================================================================

export function canonicalIf(ctx: Ctx, name: string): string | null {
  const d = ctx.d;
  const [base, sub] = name.split('.');
  if (/^Vlan\d+$/.test(base!)) {
    const v = Number(base!.slice(4));
    if (d.kind === 'router' || v < 1 || v > 4094 || sub) return null;
    return base!;
  }
  if (/^Loopback\d+$/.test(base!)) return sub ? null : base!;
  if (!d.ports.has(base!)) return null;
  if (sub !== undefined) {
    if (d.kind !== 'router' || !/^\d+$/.test(sub) || Number(sub) < 1 || Number(sub) > 4294967295) return null;
    if (d.ports.get(base!)!.spec.media === 'serial') return null;
  }
  return name;
}

function ensureIf(ctx: Ctx, name: string) {
  let i = ctx.c.interfaces.get(name);
  if (!i) {
    i = newInterface(name, ctx.d.kind, { svi: name.startsWith('Vlan') });
    if (name.includes('.') || name.startsWith('Loopback')) i.shutdown = false;
    ctx.c.interfaces.set(name, i);
  }
  return i;
}

export function targets(ctx: Ctx) {
  return ctx.s.targets.map((n) => ensureIf(ctx, n));
}

function parseIfRange(ctx: Ctx, text: string): string[] | null {
  const out: string[] = [];
  for (const partRaw of text.split(',')) {
    const toks = tokenize(partRaw.trim().replace(/-/g, ' - '));
    const r = readIface(toks, 0);
    if (!r) return null;
    const first = r[0];
    const rest = toks.slice(r[1]).map((t) => t.text);
    let last = Number(first.match(/(\d+)$/)![1]);
    if (rest.length) {
      if (rest[0] !== '-' || rest.length !== 2 || !/^\d+$/.test(rest[1]!)) return null;
      last = Number(rest[1]);
    }
    const prefix = first.replace(/\d+$/, '');
    const start = Number(first.match(/(\d+)$/)![1]);
    if (last < start) return null;
    for (let n = start; n <= last; n++) {
      const name = canonicalIf(ctx, `${prefix}${n}`);
      if (!name || name.includes('.')) return null;
      out.push(name);
    }
  }
  return out;
}

function isL2Only(ctx: Ctx, name: string): boolean {
  const i = ctx.c.interfaces.get(name);
  return !!i?.switchport;
}

function secret(ctx: Ctx, plain: string): string {
  return type5Hash(plain, saltFrom(`${ctx.d.doc.id}:${plain}:${ctx.c.hostname}`));
}

/** Accepts "word", "0 word", "7 <type7>" and "5 <hash>" password forms. */
function readPassword(text: string, allowHashed: 5 | 7 | 0): { plain?: string; hash?: string } | null {
  const m = /^(\d)\s+(\S+)$/.exec(text.trim());
  if (m) {
    if (m[1] === '0') return { plain: m[2]! };
    if (m[1] === '7' && allowHashed === 7) {
      const p = type7Decode(m[2]!);
      return p === null ? null : { plain: p };
    }
    if (m[1] === '5' && allowHashed === 5) return /^\$1\$/.test(m[2]!) ? { hash: m[2]! } : null;
  }
  return { plain: text.trim() };
}

function parseAddr(tok: string[], i: number): { ip: number; wildcard: number; used: number } | null {
  const t = tok[i];
  if (t === undefined) return null;
  if (t === 'any') return { ip: 0, wildcard: 0xffffffff, used: 1 };
  if (t === 'host') {
    const ip = parseIp(tok[i + 1] ?? '');
    return ip === null ? null : { ip, wildcard: 0, used: 2 };
  }
  const ip = parseIp(t);
  if (ip === null) return null;
  const wc = parseIp(tok[i + 1] ?? '');
  if (wc === null) return { ip, wildcard: 0, used: 1 };
  return { ip: (ip & ~wc) >>> 0, wildcard: wc, used: 2 };
}

function parseAce(num: number, text: string): AclEntry | string {
  const tok = text.trim().split(/\s+/);
  const action = tok[0];
  if (action !== 'permit' && action !== 'deny') return 'action';
  if (num <= 99) {
    const src = parseAddr(tok, 1);
    if (!src || tok.length !== 1 + src.used) return 'src';
    return { action, proto: 'ip', src: { ip: src.ip, wildcard: src.wildcard }, matches: 0 };
  }
  const proto = tok[1] as AclProto;
  if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return 'proto';
  const src = parseAddr(tok, 2);
  if (!src) return 'src';
  let i = 2 + src.used;
  const dst = parseAddr(tok, i);
  if (!dst) return 'dst';
  i += dst.used;
  const e: AclEntry = { action, proto, src: { ip: src.ip, wildcard: src.wildcard }, dst: { ip: dst.ip, wildcard: dst.wildcard }, matches: 0 };
  if (tok[i] === 'eq') {
    if (proto !== 'tcp' && proto !== 'udp') return 'eq';
    const p = tok[i + 1] ?? '';
    const port = /^\d+$/.test(p) ? Number(p) : PORT_NAMES[p];
    if (port === undefined || port > 65535) return 'port';
    e.dstPort = port;
    i += 2;
  }
  if (i !== tok.length) return 'extra';
  return e;
}

function pingOutput(ctx: Ctx, target: string, repeat: number): void {
  const v6 = target.includes(':') ? parseIp6(target) : null;
  if (v6 !== null) {
    ctx.out('Type escape sequence to abort.', `Sending ${repeat}, 100-byte ICMP Echos to ${ip6ToString(v6)}, timeout is 2 seconds:`);
    let marks = '';
    const rtts: number[] = [];
    for (let k = 0; k < repeat; k++) {
      const o = ctx.net.echo6(ctx.d.doc.id, v6);
      if (o.kind === 'reply') {
        marks += '!';
        rtts.push(Math.round(o.rtt));
      } else marks += o.kind === 'unreachable' ? 'U' : '.';
    }
    ctx.out(marks);
    const ok = rtts.length;
    ctx.out(ok ? `Success rate is ${Math.floor((ok * 100) / repeat)} percent (${ok}/${repeat}), round-trip min/avg/max = ${Math.min(...rtts)}/${Math.round(rtts.reduce((x, y) => x + y, 0) / ok)}/${Math.max(...rtts)} ms` : `Success rate is 0 percent (0/${repeat})`, '');
    return;
  }
  const dst = parseIp(target);
  if (dst === null) return ctx.out('% Unrecognized host or address, or protocol not running.', '');
  ctx.out('Type escape sequence to abort.', `Sending ${repeat}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`);
  let marks = '';
  const rtts: number[] = [];
  for (let k = 0; k < repeat; k++) {
    const o: EchoOutcome = ctx.net.echo(ctx.d.doc.id, dst, { timeout: 2000 });
    if (o.kind === 'reply') {
      marks += '!';
      rtts.push(o.rtt);
    } else if (o.kind === 'unreachable') marks += 'U';
    else if (o.kind === 'ttl-exceeded') marks += '&';
    else marks += '.';
  }
  for (let k = 0; k < marks.length; k += 70) ctx.out(marks.slice(k, k + 70));
  const ok = rtts.length;
  const pct = Math.floor((ok * 100) / repeat);
  if (ok) {
    const r = rtts.map((x) => Math.round(x));
    ctx.out(`Success rate is ${pct} percent (${ok}/${repeat}), round-trip min/avg/max = ${Math.min(...r)}/${Math.round(r.reduce((a, b) => a + b, 0) / ok)}/${Math.max(...r)} ms`, '');
  } else ctx.out(`Success rate is ${pct} percent (0/${repeat})`, '');
}

function traceOutput(ctx: Ctx, target: string): void {
  const dst = parseIp(target);
  if (dst === null) return ctx.out('% Unrecognized host or address, or protocol not running.', '');
  ctx.out('Type escape sequence to abort.', `Tracing the route to ${target}`, '');
  for (let ttl = 1; ttl <= 30; ttl++) {
    let from: number | undefined;
    const cells: string[] = [];
    let reached = false;
    for (let k = 0; k < 3; k++) {
      const o = ctx.net.udpProbe(ctx.d.doc.id, dst, ttl);
      if (o.kind === 'ttl-exceeded' || o.kind === 'port-unreachable') {
        if (from === undefined) {
          from = o.from;
          cells.push(ipToString(o.from));
        }
        cells.push(`${Math.round(o.rtt)} msec`);
        if (o.kind === 'port-unreachable') reached = true;
      } else if (o.kind === 'unreachable') {
        if (from === undefined) cells.push(ipToString(o.from));
        from = o.from;
        cells.push('!H');
        reached = true;
      } else cells.push('*');
    }
    ctx.out(`${String(ttl).padStart(3)} ${cells.join(' ')}`);
    if (reached) break;
  }
  ctx.out('');
}

function saveConfig(ctx: Ctx): void {
  ctx.d.doc.startup = ctx.net.runningConfig(ctx.d);
  ctx.out('Building configuration...', '[OK]');
}

function isModified(ctx: Ctx): boolean {
  return (ctx.d.doc.startup ?? null) !== ctx.net.runningConfig(ctx.d);
}

function doReload(ctx: Ctx): void {
  ctx.s.confirm('Proceed with reload? [confirm]', () => {
    ctx.out('');
    ctx.net.reload(ctx.d.doc.id);
    ctx.s.mode = 'user';
    ctx.s.awaitingReturn = true;
  });
}

function switchportCheck(ctx: Ctx): boolean {
  for (const n of ctx.s.targets) {
    if (!ctx.c.interfaces.get(n)?.switchport) {
      ctx.invalid(0);
      return false;
    }
  }
  return true;
}

// =============================================================================================
// Command trees
// =============================================================================================

function build(kind: DeviceKind): Record<Mode, T> {
  const isSwitch = kind === 'switch' || kind === 'l3switch';
  const user = newTree<Ctx>();
  const priv = newTree<Ctx>();
  const config = newTree<Ctx>();
  const cif = newTree<Ctx>();
  const line = newTree<Ctx>();
  const vlan = newTree<Ctx>();
  const router = newTree<Ctx>();
  const dhcp = newTree<Ctx>();

  // ---------------------------------------------------------------- EXEC (user + privileged)
  for (const t of [user, priv]) {
    def(t, 'enable', (c) => c.s.enable());
    def(t, 'exit', (c) => c.s.logout());
    def(t, 'logout', (c) => c.s.logout());
    def(t, 'ping <ip>', (c, a) => pingOutput(c, a.p[0]!, 5), ['', 'Ping destination address or hostname']);
    def(t, 'ping <ip> repeat <1-2147483647>', (c, a) => pingOutput(c, a.p[0]!, Math.min(Number(a.p[1]), 1000)), ['', '', 'specify repeat count', 'Repeat count']);
    def(t, 'ping <WORD>', (c, a) => pingOutput(c, a.p[0]!, 5), ['', 'Ping destination address or hostname']);
    def(t, 'traceroute <ip>', (c, a) => traceOutput(c, a.p[0]!), ['', 'Trace route to destination address or hostname']);
    def(t, 'traceroute <WORD>', (c, a) => traceOutput(c, a.p[0]!));
    def(t, 'terminal length <0-512>', (c, a) => (c.s.termLength = Number(a.p[0])), ['Set terminal line parameters']);
    defShows(t, t === priv, isSwitch, kind);
  }
  def(priv, 'disable', (c) => (c.s.mode = 'user'));
  def(priv, 'configure terminal', (c) => {
    c.out('Enter configuration commands, one per line.  End with CNTL/Z.');
    c.s.mode = 'config';
  });
  def(priv, 'configure', (c) =>
    c.s.ask('Configuring from terminal, memory, or network [terminal]? ', (ans) => {
      if (ans.trim() === '' || 'terminal'.startsWith(ans.trim().toLowerCase())) {
        c.out('Enter configuration commands, one per line.  End with CNTL/Z.');
        c.s.mode = 'config';
      } else c.out('?Must be "terminal", "memory" or "network"');
    }),
  );
  def(priv, 'copy running-config startup-config', (c) =>
    c.s.ask('Destination filename [startup-config]? ', (ans) => {
      if (ans.trim() && ans.trim() !== 'startup-config') return c.out('%Error opening flash:' + ans.trim() + ' (Not implemented in TPacket yet)');
      saveConfig(c);
    }),
    ['', 'Copy from current system configuration', 'Copy to startup configuration'],
  );
  def(priv, 'copy startup-config running-config', (c) =>
    c.s.ask('Destination filename [running-config]? ', () => {
      const text = c.d.doc.startup;
      if (!text) return c.out('%Error opening nvram:startup-config (No such file or directory)');
      const prevMode = c.s.mode;
      c.s.mode = 'config';
      const errs = replay(c.s, text);
      c.s.mode = prevMode;
      c.out(...errs, `${text.length} bytes copied in 0.416 secs (${Math.round(text.length / 0.416)} bytes/sec)`);
      c.net.console(c.d.doc.id, '%SYS-5-CONFIG_I: Configured from console by console');
    }),
    ['', 'Copy from startup configuration', 'Update (merge with) current system configuration'],
  );
  def(priv, 'write', (c) => saveConfig(c));
  def(priv, 'write memory', (c) => saveConfig(c));
  def(priv, 'write terminal', (c) => c.out('Building configuration...', '', `Current configuration : ${c.net.runningConfig(c.d).length} bytes`, c.net.runningConfig(c.d)), ['', 'Write to terminal']);
  const erase = (c: Ctx) =>
    c.s.confirm('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', () => {
      c.d.doc.startup = null;
      c.out('[OK]', 'Erase of nvram: complete');
      c.net.console(c.d.doc.id, '%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram');
    });
  def(priv, 'erase startup-config', erase);
  def(priv, 'write erase', erase, ['', 'Erase NV memory']);
  def(priv, 'reload', (c) => {
    if (isModified(c)) {
      c.s.ask('System configuration has been modified. Save? [yes/no]: ', (ans) => {
        const a = ans.trim().toLowerCase();
        if (a.startsWith('y')) {
          saveConfig(c);
          doReload(c);
        } else if (a.startsWith('n')) doReload(c);
        else c.out('% Please answer \'yes\' or \'no\'.');
      });
    } else doReload(c);
  });
  def(priv, 'clock set <hh:mm:ss> <1-31> <MONTH> <1993-2035>', (c, a) => {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(a.p[0]!);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.findIndex((x) => a.p[2]!.toLowerCase().startsWith(x));
    if (!m || mi < 0 || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return c.invalid(2);
    const target = Date.UTC(Number(a.p[3]), mi, Number(a.p[1]), Number(m[1]), Number(m[2]), Number(m[3]));
    c.d.clockOffset = target - Date.UTC(1993, 2, 1) - c.net.now || 1;
  }, ['', 'Set the time and date', 'Current Time ( hh:mm:ss )', 'Day of the month', 'Month of the year', 'Year']);

  // ---------------------------------------------------------------- Global configuration
  const exitToPriv = (c: Ctx) => c.s.endConfig();
  for (const t of [config, cif, line, vlan, router, dhcp]) {
    def(t, 'end', exitToPriv);
    def(t, 'do <line>', (c, a) => {
      const saved = c.s.mode;
      c.s.mode = 'priv';
      c.s.execute(a.p[0]!);
      if (c.s.mode === 'priv') c.s.mode = saved;
    });
  }
  def(config, 'exit', exitToPriv);
  for (const t of [cif, line, vlan]) {
    def(t, 'exit', (c) => {
      c.s.mode = 'config';
      c.s.targets = [];
    });
  }

  def(config, 'hostname <WORD>', (c, a) => {
    const h = a.p[0]!;
    if (!/^[A-Za-z]/.test(h) || !/^[A-Za-z0-9-]+$/.test(h) || h.length > 63) return c.out('% Hostname contains one or more illegal characters.');
    c.c.hostname = h;
  }, ['', "This system's network name"]);
  def(config, 'no hostname', (c) => (c.c.hostname = c.d.kind === 'router' ? 'Router' : 'Switch'));

  def(config, 'enable secret <line>', (c, a) => {
    const p = readPassword(a.p[0]!, 5);
    if (!p) return c.out('ERROR: The secret you entered is not a valid encrypted secret.');
    c.c.enableSecret = p.hash ?? secret(c, p.plain!);
    if (p.plain !== undefined && p.plain === c.c.enablePassword) c.out('The enable secret you have chosen is the same as your enable password.', 'This is not recommended.  Re-enter the enable secret.');
  }, ['', 'Assign the privileged level secret', 'The UNENCRYPTED (cleartext) \'enable\' secret']);
  def(config, 'enable password <line>', (c, a) => {
    const p = readPassword(a.p[0]!, 7);
    if (!p?.plain) return c.out('Invalid encrypted password');
    c.c.enablePassword = p.plain;
  }, ['', 'Assign the privileged level password', 'The UNENCRYPTED (cleartext) \'enable\' password']);
  def(config, 'no enable secret', (c) => delete c.c.enableSecret);
  def(config, 'no enable password', (c) => delete c.c.enablePassword);
  def(config, 'service password-encryption', (c) => (c.c.servicePasswordEncryption = true));
  def(config, 'no service password-encryption', (c) => (c.c.servicePasswordEncryption = false));
  def(config, 'version <WORD>', () => {}, [], { hidden: true });

  def(config, 'banner motd <line>', (c, a) => {
    const text = a.p[0]!;
    const delim = text.startsWith('^C') ? '^C' : text[0]!;
    const rest = text.slice(delim.length);
    const end = rest.indexOf(delim);
    if (end >= 0) {
      c.c.bannerMotd = rest.slice(0, end);
      return;
    }
    // Interactive multi-line banner.
    c.out(`Enter TEXT message.  End with the character '${delim}'.`);
    let body = rest;
    const more = () =>
      c.s.ask('', (l) => {
        const k = l.indexOf(delim);
        if (k >= 0) {
          body += (body ? '\n' : '') + l.slice(0, k);
          c.c.bannerMotd = body;
        } else {
          body += (body ? '\n' : '') + l;
          more();
        }
      });
    more();
  }, ['', 'Set Message of the Day banner', 'c  banner-text c, where \'c\' is a delimiting character']);
  def(config, 'no banner motd', (c) => delete c.c.bannerMotd);

  def(config, 'ip domain-name <WORD>', (c, a) => (c.c.domainName = a.p[0]!), ['', '', 'Default domain name']);
  def(config, 'no ip domain-name', (c) => delete c.c.domainName);
  def(config, 'ip domain-lookup', (c) => (c.c.domainLookup = true));
  def(config, 'no ip domain-lookup', (c) => (c.c.domainLookup = false));

  const genRsa = (c: Ctx, bits?: number) => {
    if (c.c.hostname === 'Router' || c.c.hostname === 'Switch') return c.out(`% Please define a hostname other than ${c.c.hostname}.`);
    if (!c.c.domainName) return c.out('% Please define a domain-name first.');
    const finish = (n: number) => {
      if (n < 360 || n > 2048) return c.out('% Key modulus must be between 360 and 2048');
      c.d.doc.rsaModulus = n;
      c.out(`% Generating ${n} bit RSA keys, keys will be non-exportable...[OK]`, '');
      c.net.console(c.d.doc.id, `%SSH-5-ENABLED: SSH 1.99 has been enabled`);
    };
    if (bits) return finish(bits);
    c.out(`The name for the keys will be: ${c.c.hostname}.${c.c.domainName}`, 'Choose the size of the key modulus in the range of 360 to 2048 for your', '  General Purpose Keys. Choosing a key modulus greater than 512 may take', '  a few minutes.', '');
    c.s.ask('How many bits in the modulus [512]: ', (ans) => {
      const n = ans.trim() === '' ? 512 : Number(ans.trim());
      if (!Number.isInteger(n)) return c.out('% A decimal number between 360 and 2048.');
      finish(n);
    });
  };
  def(config, 'crypto key generate rsa', (c) => genRsa(c));
  def(config, 'crypto key generate rsa general-keys modulus <360-2048>', (c, a) => genRsa(c, Number(a.p[0])), ['', '', '', '', 'Generate a general purpose RSA key pair for signing and encryption', 'Provide number of modulus bits on the command line']);
  def(config, 'crypto key zeroize rsa', (c) => {
    delete c.d.doc.rsaModulus;
    c.net.console(c.d.doc.id, '%SSH-5-DISABLED: SSH 1.99 has been disabled');
  });
  def(config, 'ip ssh version <1-2>', (c, a) => {
    if (!c.d.doc.rsaModulus) return c.out('Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).');
    if (a.p[0] === '2' && c.d.doc.rsaModulus < 768) return c.out('Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).');
    c.c.sshVersion = Number(a.p[0]) as 1 | 2;
  }, ['', '', 'Specify protocol version supported']);
  def(config, 'no ip ssh version', (c) => delete c.c.sshVersion);

  def(config, 'username <WORD> secret <line>', (c, a) => setUser(c, a.p[0]!, 1, a.p[1]!, true), ['', '', 'Specify the secret for the user']);
  def(config, 'username <WORD> password <line>', (c, a) => setUser(c, a.p[0]!, 1, a.p[1]!, false), ['', '', 'Specify the password for the user']);
  def(config, 'username <WORD> privilege <0-15> secret <line>', (c, a) => setUser(c, a.p[0]!, Number(a.p[1]), a.p[2]!, true));
  def(config, 'username <WORD> privilege <0-15> password <line>', (c, a) => setUser(c, a.p[0]!, Number(a.p[1]), a.p[2]!, false));
  def(config, 'no username <WORD>', (c, a) => (c.c.users = c.c.users.filter((u) => u.name !== a.p[0])));

  def(config, 'cdp run', (c) => (c.c.cdpRun = true));
  def(config, 'no cdp run', (c) => (c.c.cdpRun = false));

  // Interfaces
  def(config, 'interface <iface>', (c, a) => {
    const name = canonicalIf(c, a.p[0]!);
    if (!name) return c.out('%Invalid interface type and number');
    const existed = c.c.interfaces.has(name);
    const i = ensureIf(c, name);
    // When IOS boots from a saved configuration, an interface block without "shutdown" comes up
    // (a merge such as `copy startup-config running-config` does NOT do this, as on real IOS).
    if (c.s.opts.replay) i.shutdown = false;
    if (!existed && name.startsWith('Vlan') && !c.s.opts.replay) c.net.console(c.d.doc.id, `%LINK-5-CHANGED: Interface ${name}, changed state to administratively down`);
    c.s.targets = [name];
    c.s.mode = name.includes('.') ? 'config-subif' : 'config-if';
  });
  def(config, 'interface range <line>', (c, a) => {
    const names = parseIfRange(c, a.p[0]!);
    if (!names) return c.invalid(2);
    c.s.targets = names;
    c.s.mode = 'config-if-range';
  }, ['', 'interface range command']);
  def(config, 'no interface <iface>', (c, a) => {
    const name = canonicalIf(c, a.p[0]!);
    if (!name || !(name.includes('.') || name.startsWith('Vlan') || name.startsWith('Loopback'))) return c.out('% Physical interfaces cannot be removed.');
    c.c.interfaces.delete(name);
  });

  // Routing
  def(config, 'ip route <ip> <ip> <ip>', (c, a) => addStatic(c, a.p[0]!, a.p[1]!, a.p[2]!, undefined, 1), ['', 'Establish static routes', 'Destination prefix', 'Destination prefix mask', 'Forwarding router\'s address']);
  def(config, 'ip route <ip> <ip> <ip> <1-255>', (c, a) => addStatic(c, a.p[0]!, a.p[1]!, a.p[2]!, undefined, Number(a.p[3])), ['', '', '', '', '', 'Distance metric for this route']);
  def(config, 'ip route <ip> <ip> <iface>', (c, a) => addStatic(c, a.p[0]!, a.p[1]!, undefined, a.p[2]!, 1));
  def(config, 'ip route <ip> <ip> <iface> <1-255>', (c, a) => addStatic(c, a.p[0]!, a.p[1]!, undefined, a.p[2]!, Number(a.p[3])));
  def(config, 'ip route <ip> <ip> <iface> <ip>', (c, a) => addStatic(c, a.p[0]!, a.p[1]!, a.p[3]!, a.p[2]!, 1));
  const noRoute = (c: Ctx, a: Args) => {
    const net = parseIp(a.p[0]!)!;
    const mask = parseIp(a.p[1]!)!;
    const before = c.c.staticRoutes.length;
    const nh = a.p[2] ? parseIp(a.p[2]) : null;
    const ifn = a.p[2] && nh === null ? a.p[2] : undefined;
    c.c.staticRoutes = c.c.staticRoutes.filter((r) => !(r.network === net && r.mask === mask && (a.p.length === 2 || (nh !== null && r.nextHop === nh) || (ifn && r.iface === ifn))));
    if (c.c.staticRoutes.length === before) c.out('%No matching route to delete');
  };
  def(config, 'no ip route <ip> <ip>', noRoute);
  def(config, 'no ip route <ip> <ip> <ip>', noRoute);
  def(config, 'no ip route <ip> <ip> <iface>', noRoute);
  def(config, 'ip default-gateway <ip>', (c, a) => (c.c.defaultGateway = parseIp(a.p[0]!)!), ['', '', 'IP address of default gateway']);
  def(config, 'no ip default-gateway', (c) => delete c.c.defaultGateway);
  if (kind === 'router' || kind === 'l3switch') {
    def(config, 'ip routing', (c) => (c.c.ipRouting = true));
    def(config, 'no ip routing', (c) => {
      c.c.ipRouting = false;
    });
  }

  // Access lists
  def(config, 'access-list <1-99> <line>', (c, a) => addAce(c, a), ['', 'IP standard access list', 'permit | deny  source [wildcard] | host source | any']);
  def(config, 'access-list <100-199> <line>', (c, a) => addAce(c, a), ['', 'IP extended access list', 'permit | deny  protocol source destination [eq port]']);
  def(config, 'no access-list <1-199>', (c, a) => c.c.acls.delete(a.p[0]!));

  // Lines
  def(config, 'line console 0', (c) => {
    c.s.lineTarget = 'con';
    c.s.mode = 'config-line';
  }, ['', '', 'First Line number']);
  const vty = (c: Ctx, a: Args) => {
    const lo = Number(a.p[0]);
    const hi = a.p[1] !== undefined ? Number(a.p[1]) : lo;
    if (hi < lo) return c.out('%Invalid line range');
    c.s.lineTarget = 'vty';
    c.s.mode = 'config-line';
  };
  def(config, 'line vty <0-15>', vty, ['', '', 'First Line number']);
  def(config, 'line vty <0-15> <1-15>', vty, ['', '', '', 'Last Line number']);

  if (isSwitch) {
    def(config, 'vlan <line>', (c, a) => {
      const ids = parseVlanList(a.p[0]!);
      if (!ids) return c.invalid(1);
      if (ids.some((v) => v >= 1002 && v <= 1005)) return c.out(`Default VLAN ${ids.find((v) => v >= 1002)} may not have its name changed.`);
      for (const v of ids) if (v !== 1) createVlan(c, v);
      c.s.vlanTargets = ids;
      c.s.mode = 'config-vlan';
    }, ['', 'ISL VLAN IDs 1-1005']);
    def(config, 'no vlan <line>', (c, a) => {
      const ids = parseVlanList(a.p[0]!);
      if (!ids) return c.invalid(2);
      if (ids.includes(1)) return c.out('Default VLAN 1 may not be deleted.');
      c.d.doc.vlanDb = (c.d.doc.vlanDb ?? []).filter((v) => !ids.includes(v.id));
    });
    def(config, 'spanning-tree vlan <1-4094> priority <0-61440>', (c, a) => {
      const p = Number(a.p[1]);
      if (p % 4096) return c.out('% Bridge Priority must be in increments of 4096.', '% Allowed values are:', '  0     4096  8192  12288 16384 20480 24576 28672', '  32768 36864 40960 45056 49152 53248 57344 61440');
      c.c.stpPriority.set(Number(a.p[0]), p);
    }, ['', '', 'VLAN ID', 'Set the bridge priority for the spanning tree', 'bridge priority in increments of 4096']);
    def(config, 'no spanning-tree vlan <1-4094> priority', (c, a) => c.c.stpPriority.delete(Number(a.p[0])));
    def(config, 'spanning-tree vlan <1-4094> root primary', (c, a) => c.c.stpPriority.set(Number(a.p[0]), 24576), ['', '', '', 'Configure switch as root', 'Configure this switch as primary root for this spanning tree']);
    def(config, 'spanning-tree mode pvst', () => {}, ['', 'Spanning tree operating mode', 'Per-Vlan spanning tree mode']);
  }

  // ---------------------------------------------------------------- Interface configuration
  const allIf = [cif];
  for (const t of allIf) {
    def(t, 'description <line>', (c, a) => targets(c).forEach((i) => (i.description = a.p[0]!.slice(0, 240))), ['', 'Up to 240 characters describing this interface']);
    def(t, 'no description', (c) => targets(c).forEach((i) => delete i.description));
    def(t, 'shutdown', (c) => targets(c).forEach((i) => (i.shutdown = true)));
    def(t, 'no shutdown', (c) => targets(c).forEach((i) => (i.shutdown = false)));
    def(t, 'ip address <ip> <ip>', (c, a) => setIp(c, a.p[0]!, a.p[1]!), ['', 'Interface Internet Protocol config commands', 'Set the IP address of an interface', 'IP address', 'IP subnet mask']);
    def(t, 'no ip address', (c) => targets(c).forEach((i) => delete i.ip));
    def(t, 'no ip address <ip> <ip>', (c) => targets(c).forEach((i) => delete i.ip));
    def(t, 'ip helper-address <ip>', (c, a) => targets(c).forEach((i) => { const h = parseIp(a.p[0]!)!; if (!i.helpers.includes(h)) i.helpers.push(h); }), ['', '', '', 'IP destination address']);
    def(t, 'no ip helper-address <ip>', (c, a) => targets(c).forEach((i) => (i.helpers = i.helpers.filter((h) => h !== parseIp(a.p[0]!)))));
    def(t, 'ip access-group <1-199> in', (c, a) => targets(c).forEach((i) => (i.aclIn = a.p[0]!)), ['', '', '', 'IP access list (standard or extended)']);
    def(t, 'ip access-group <1-199> out', (c, a) => targets(c).forEach((i) => (i.aclOut = a.p[0]!)));
    def(t, 'no ip access-group <1-199> in', (c) => targets(c).forEach((i) => delete i.aclIn));
    def(t, 'no ip access-group <1-199> out', (c) => targets(c).forEach((i) => delete i.aclOut));
    def(t, 'no ip access-group <1-199>', (c) => targets(c).forEach((i) => { delete i.aclIn; delete i.aclOut; }));
    def(t, 'ip proxy-arp', (c) => targets(c).forEach((i) => (i.proxyArp = true)));
    def(t, 'no ip proxy-arp', (c) => targets(c).forEach((i) => (i.proxyArp = false)));
    def(t, 'speed <line>', (c, a) => {
      const v = a.p[0]!.trim();
      if (!['10', '100', '1000', 'auto'].includes(v)) return c.invalid(1);
      for (const i of targets(c)) {
        const port = c.d.ports.get(i.name);
        if (!port || port.spec.media === 'serial') return c.invalid(0);
        if (v !== 'auto' && Number(v) > port.spec.speed) return c.invalid(1);
        i.speed = v as '10' | '100' | '1000' | 'auto';
      }
    }, ['', '10 | 100 | 1000 | auto']);
    def(t, 'duplex <line>', (c, a) => {
      const v = a.p[0]!.trim();
      if (!['auto', 'full', 'half'].includes(v)) return c.invalid(1);
      targets(c).forEach((i) => (i.duplex = v as 'auto' | 'full' | 'half'));
    }, ['', 'auto | full | half']);
    def(t, 'clock rate <300-8000000>', (c, a) => {
      const rate = Number(a.p[0]);
      for (const i of targets(c)) {
        if (!i.name.startsWith('Serial')) return c.invalid(0);
        if (!VALID_CLOCK_RATES.includes(rate)) {
          c.out('', 'unknown clock rate');
          return;
        }
        const pr = c.s.opts.replay ? undefined : c.net.peer(c.d.doc.id, i.name);
        if (pr) {
          const dce = c.net.serialDce(pr.link);
          if (!(dce.device === c.d.doc.id && dce.port === i.name)) return c.out('This command applies only to DCE interfaces');
        }
        i.clockRate = rate;
      }
    }, ['', 'Configure serial interface clock', 'Configure serial interface clock speed', 'Choose clockrate from list above']);
    def(t, 'no clock rate', (c) => targets(c).forEach((i) => delete i.clockRate));
  }
  def(cif, 'encapsulation dot1Q <1-4094>', (c, a) => setDot1q(c, Number(a.p[0]), false), ['', '', 'IEEE 802.1Q VLAN ID']);
  def(cif, 'encapsulation dot1Q <1-4094> native', (c, a) => setDot1q(c, Number(a.p[0]), true), ['', '', '', 'Make this as native vlan']);
  def(cif, 'no encapsulation dot1Q', (c) => targets(c).forEach((i) => delete i.dot1q));

  if (isSwitch) {
    const sp = (fn: (i: ReturnType<typeof ensureIf>, c: Ctx) => void) => (c: Ctx) => {
      if (!switchportCheck(c)) return;
      targets(c).forEach((i) => fn(i, c));
    };
    const setMode = (m: SwitchportMode) => sp((i) => (i.mode = m));
    def(cif, 'switchport mode access', setMode('access'), ['', '', 'Set trunking mode to ACCESS unconditionally']);
    def(cif, 'switchport mode trunk', setMode('trunk'), ['', '', 'Set trunking mode to TRUNK unconditionally']);
    def(cif, 'switchport mode dynamic auto', setMode('dynamic auto'));
    def(cif, 'switchport mode dynamic desirable', setMode('dynamic desirable'));
    def(cif, 'no switchport mode', setMode('dynamic auto'));
    def(cif, 'switchport access vlan <1-4094>', (c, a) => {
      if (!switchportCheck(c)) return;
      const v = Number(a.p[0]);
      if (!c.net.vlanExists(c.d, v)) {
        c.out(`% Access VLAN does not exist. Creating vlan ${v}`);
        createVlan(c, v);
      }
      targets(c).forEach((i) => (i.accessVlan = v));
    }, ['', 'Set access mode characteristics of the interface', 'Set VLAN when interface is in access mode', 'VLAN ID of the VLAN when this port is in access mode']);
    def(cif, 'no switchport access vlan', sp((i) => (i.accessVlan = 1)));
    def(cif, 'switchport trunk native vlan <1-4094>', (c, a) => {
      if (!switchportCheck(c)) return;
      targets(c).forEach((i) => (i.nativeVlan = Number(a.p[0])));
    }, ['', '', 'Set trunking native characteristics when interface is in trunking mode', 'Set native VLAN when interface is in trunking mode', 'VLAN ID of the native VLAN when this port is in trunking mode']);
    def(cif, 'no switchport trunk native vlan', sp((i) => (i.nativeVlan = 1)));
    def(cif, 'switchport trunk allowed vlan <line>', (c, a) => {
      if (!switchportCheck(c)) return;
      const spec = a.p[0]!.trim();
      for (const i of targets(c)) {
        const all = Array.from({ length: 4094 }, (_, k) => k + 1);
        const current = i.allowed ?? all;
        const m = /^(add|remove|except)\s+(.+)$/.exec(spec);
        let next: number[] | null;
        if (spec === 'all') next = null;
        else if (spec === 'none') next = [];
        else if (m) {
          const list = parseVlanList(m[2]!);
          if (!list) return c.invalid(4);
          if (m[1] === 'add') next = [...new Set([...current, ...list])].sort((x, y) => x - y);
          else if (m[1] === 'remove') next = current.filter((v) => !list.includes(v));
          else next = all.filter((v) => !list.includes(v));
        } else {
          next = parseVlanList(spec);
          if (!next) return c.invalid(4);
        }
        i.allowed = next && next.length === 4094 ? null : next;
      }
    }, ['', '', 'Set allowed VLAN characteristics when interface is in trunking mode', 'Set allowed VLANs when interface is in trunking mode', 'WORD | all | none | add WORD | remove WORD | except WORD']);
    def(cif, 'no switchport trunk allowed vlan', sp((i) => (i.allowed = null)));
    def(cif, 'spanning-tree portfast', (c) => {
      if (!switchportCheck(c)) return;
      targets(c).forEach((i) => (i.portfast = true));
      if (!c.s.opts.replay) c.out('%Warning: portfast should only be enabled on ports connected to a single', ' host. Connecting hubs, concentrators, switches, bridges, etc... to this', ' interface  when portfast is enabled, can cause temporary bridging loops.', ' Use with CAUTION', '');
    });
    def(cif, 'no spanning-tree portfast', sp((i) => (i.portfast = false)));
    if (kind === 'l3switch') {
      def(cif, 'switchport', (c) => targets(c).forEach((i) => {
        if (i.name.startsWith('Vlan') || i.name.startsWith('Loopback')) return c.invalid(0);
        i.switchport = true;
        delete i.ip;
      }));
      def(cif, 'no switchport', (c) => targets(c).forEach((i) => {
        if (i.name.startsWith('Vlan') || i.name.startsWith('Loopback')) return c.invalid(0);
        i.switchport = false;
      }));
      def(cif, 'switchport trunk encapsulation dot1q', sp(() => {}), ['', '', 'Set trunking encapsulation when interface is in trunking mode', 'Interface uses only 802.1q trunking encapsulation when trunking']);
    }
  }

  // ---------------------------------------------------------------- Line configuration
  const L = (c: Ctx) => (c.s.lineTarget === 'con' ? c.c.con : c.c.vty);
  def(line, 'password <line>', (c, a) => {
    const p = readPassword(a.p[0]!, 7);
    if (!p?.plain) return c.out('Invalid encrypted password');
    L(c).password = p.plain;
  }, ['', 'The UNENCRYPTED (cleartext) line password']);
  def(line, 'no password', (c) => delete L(c).password);
  def(line, 'login', (c) => {
    L(c).login = 'line';
    if (L(c).password === undefined && !c.s.opts.replay) c.out('% Login disabled on line ' + (c.s.lineTarget === 'con' ? '0' : '1') + ', until \'password\' is set');
  });
  def(line, 'login local', (c) => (L(c).login = 'local'), ['', 'Local password checking']);
  def(line, 'no login', (c) => (L(c).login = 'none'));
  def(line, 'transport input <line>', (c, a) => {
    const v = a.p[0]!.trim().split(/\s+/).sort().join(' ');
    const map: Record<string, 'all' | 'ssh' | 'telnet' | 'none'> = { all: 'all', ssh: 'ssh', telnet: 'telnet', none: 'none', 'ssh telnet': 'all' };
    const m = map[v];
    if (!m) return c.invalid(2);
    L(c).transport = m;
  }, ['', '', 'all | none | ssh | telnet']);
  def(line, 'exec-timeout <0-35791> <0-2147483>', (c, a) => (L(c).execTimeout = [Number(a.p[0]), Number(a.p[1])]), ['', 'Timeout in minutes', 'Timeout in seconds']);
  def(line, 'exec-timeout <0-35791>', (c, a) => (L(c).execTimeout = [Number(a.p[0]), 0]));
  def(line, 'logging synchronous', (c) => (L(c).loggingSync = true));
  def(line, 'no logging synchronous', (c) => (L(c).loggingSync = false));
  def(line, 'no exec-timeout', (c) => delete L(c).execTimeout);

  // ---------------------------------------------------------------- VLAN configuration
  def(vlan, 'name <WORD>', (c, a) => {
    for (const v of c.s.vlanTargets) {
      if (v === 1) return c.out('Default VLAN 1 may not have its name changed.');
      const e = c.d.doc.vlanDb!.find((x) => x.id === v);
      if (e) e.name = a.p[0]!.slice(0, 32);
    }
  }, ['', 'The ascii name for the VLAN']);
  def(vlan, 'no name', (c) => {
    for (const v of c.s.vlanTargets) {
      const e = c.d.doc.vlanDb!.find((x) => x.id === v);
      if (e) e.name = `VLAN${String(v).padStart(4, '0')}`;
    }
  });

  defineL3({ user, priv, config, cif, router, dhcp, canonicalIf, targets }, kind);

  return {
    'config-router': router,
    'config-dhcp': dhcp,
    user,
    priv,
    config,
    'config-if': cif,
    'config-if-range': cif,
    'config-subif': cif,
    'config-line': line,
    'config-vlan': vlan,
  };
}

function defShows(t: T, privileged: boolean, isSwitch: boolean, kind: DeviceKind): void {
  if (privileged) {
    def(t, 'show running-config', (c) => {
      const txt = c.net.runningConfig(c.d);
      c.out('Building configuration...', '', `Current configuration : ${txt.length} bytes`, txt.trimEnd());
    });
    def(t, 'show startup-config', (c) => {
      const s = c.d.doc.startup;
      if (!s) return c.out('startup-config is not present');
      c.out(`Using ${s.length} bytes`, s.trimEnd());
    });
    def(t, 'show access-lists', (c) => c.out(show.showAccessLists(c.d)));
  }
  def(t, 'show version', (c) => c.out(show.showVersion(c.net, c.d)));
  def(t, 'show clock', (c) => c.out(show.clockText(c.net, c.d)));
  def(t, 'show history', (c) => c.out(...c.s.history.map((h) => `  ${h}`)));
  def(t, 'show ip interface brief', (c) => c.out(show.ipIntBrief(c.net, c.d)));
  def(t, 'show interfaces', (c) => c.out(show.showInterfaces(c.net, c.d)));
  def(t, 'show interfaces <iface>', (c, a) => {
    const name = canonicalIf(c, a.p[0]!);
    if (!name || !c.c.interfaces.has(name)) return c.invalid(2);
    c.out(show.showInterfaces(c.net, c.d, name));
  });
  def(t, 'show ip route', (c) => c.out(show.showIpRoute(c.net, c.d)));
  def(t, 'show arp', (c) => c.out(show.showArp(c.net, c.d)));
  def(t, 'show ip arp', (c) => c.out(show.showArp(c.net, c.d)));
  def(t, 'show cdp neighbors', (c) => c.out(show.showCdp(c.net, c.d)));
  if (isSwitch) {
    def(t, 'show mac address-table', (c) => c.out(show.showMacTable(c.net, c.d)), ['', 'MAC configuration', 'MAC forwarding table']);
    def(t, 'show mac-address-table', (c) => c.out(show.showMacTable(c.net, c.d)));
    def(t, 'show vlan', (c) => c.out(show.showVlanBrief(c.net, c.d, false)));
    def(t, 'show vlan brief', (c) => c.out(show.showVlanBrief(c.net, c.d, true)), ['', '', 'VTP all VLAN status in brief']);
    def(t, 'show interfaces trunk', (c) => c.out(show.showTrunk(c.net, c.d)));
    def(t, 'show spanning-tree', (c) => c.out(show.showSpanningTree(c.net, c.d)));
  }
  void kind;
}

// =============================================================================================
// Command implementations
// =============================================================================================

function setUser(c: Ctx, name: string, privilege: number, pw: string, isSecret: boolean): void {
  const p = readPassword(pw, isSecret ? 5 : 7);
  if (!p) return c.out('ERROR: The secret you entered is not a valid encrypted secret.');
  const u = c.c.users.find((x) => x.name === name) ?? { name, privilege };
  u.privilege = privilege;
  delete u.secret;
  delete u.password;
  if (isSecret) u.secret = p.hash ?? secret(c, p.plain!);
  else u.password = p.plain!;
  if (!c.c.users.includes(u)) c.c.users.push(u);
}

function createVlan(c: Ctx, v: number): void {
  const db = (c.d.doc.vlanDb ??= []);
  if (v !== 1 && !db.some((x) => x.id === v)) {
    db.push({ id: v, name: `VLAN${String(v).padStart(4, '0')}` });
    db.sort((a, b) => a.id - b.id);
  }
}

function setIp(c: Ctx, ipText: string, maskText: string): void {
  const ip = parseIp(ipText)!;
  const mask = parseIp(maskText)!;
  if (maskToPrefix(mask) === null || mask === 0) return c.out(`Bad mask 0x${mask.toString(16).toUpperCase()} for address ${ipText}`);
  for (const i of targets(c)) {
    if (c.d.kind === 'switch' && !i.name.startsWith('Vlan') && !i.name.startsWith('Loopback')) return c.invalid(0);
    if (isL2Only(c, i.name)) return c.out('% IP addresses may not be configured on L2 links.');
    if (i.name.includes('.') && !i.dot1q) {
      return c.out('', '% Configuring IP routing on a LAN subinterface is only allowed if that', 'subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,', 'or ISL vLAN.', '');
    }
    if (!isUsableHost(ip, mask)) return c.out(`Bad mask /${maskToPrefix(mask)} for address ${ipText}`);
    for (const o of c.c.interfaces.values()) {
      if (o === i || !o.ip || o.switchport) continue;
      const m = Math.min(o.ip.mask >>> 0, mask >>> 0) >>> 0;
      if (networkOf(o.ip.address, m) === networkOf(ip, m)) {
        return c.out(`% ${ipToString(networkOf(ip, mask))} overlaps with ${o.name}`);
      }
    }
    i.ip = { address: ip, mask };
  }
}

function setDot1q(c: Ctx, vlan: number, native: boolean): void {
  for (const i of targets(c)) {
    if (!i.name.includes('.')) return c.invalid(0);
    const parent = i.name.split('.')[0]!;
    for (const o of c.c.interfaces.values()) {
      if (o !== i && o.name.startsWith(parent + '.') && o.dot1q?.vlan === vlan) return c.out(`Configuration of multiple subinterfaces of the same main`, `interface with the same VID (${vlan}) is not permitted.`, `This VID is already configured on ${o.name}.`);
    }
    i.dot1q = { vlan, native };
  }
}

function addStatic(c: Ctx, netText: string, maskText: string, nhText: string | undefined, iface: string | undefined, distance: number): void {
  const network = parseIp(netText)!;
  const mask = parseIp(maskText)!;
  if (maskToPrefix(mask) === null) return c.out('%Invalid destination prefix');
  if (networkOf(network, mask) !== network) return c.out('%Inconsistent address and mask');
  let ifName: string | undefined;
  if (iface) {
    const n = canonicalIf(c, iface);
    if (!n || (!c.c.interfaces.has(n) && !c.d.ports.has(n))) return c.out('%Invalid interface type and number');
    ifName = n;
  }
  let nextHop: number | undefined;
  if (nhText !== undefined) {
    nextHop = parseIp(nhText)!;
    if ([...c.c.interfaces.values()].some((i) => i.ip?.address === nextHop)) return c.out('%Invalid next hop address (it\'s this router)');
  }
  const dup = c.c.staticRoutes.find((r) => r.network === network && r.mask === mask && r.nextHop === nextHop && r.iface === ifName);
  if (dup) {
    dup.distance = distance;
    return;
  }
  c.c.staticRoutes.push({ network, mask, distance, ...(nextHop !== undefined ? { nextHop } : {}), ...(ifName ? { iface: ifName } : {}) });
}

function addAce(c: Ctx, a: Args): void {
  const num = Number(a.p[0]);
  const e = parseAce(num, a.p[1]!);
  if (typeof e === 'string') return c.invalid(2);
  const list = c.c.acls.get(String(num)) ?? [];
  list.push(e);
  c.c.acls.set(String(num), list);
}

