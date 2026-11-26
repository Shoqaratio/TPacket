import { IosSession } from '../ios/session';
import { ipToString, parseIp } from '../net/ipv4';
import { ip6ToString, parseIp6 } from '../net/ipv6';
import { macCisco, macWindows } from '../net/mac';
import type { EchoOutcome, Network } from '../sim/network';

/** Desktop > Command Prompt of an end device. Also hosts outgoing Telnet/SSH sessions. */
export class HostPrompt {
  history: string[] = [];
  private remote: { session: IosSession; ip: string } | null = null;

  constructor(
    public net: Network,
    public devId: string,
  ) {}

  prompt(): string {
    return this.remote ? this.remote.session.prompt() : 'C:\\>';
  }

  isSecretInput(): boolean {
    return !!this.remote?.session.isSecretInput();
  }

  greeting(): string {
    return '\nCisco Packet Tracer PC Command Line 1.0 compatible — TPacket\n';
  }

  input(raw: string): string {
    if (this.remote) {
      const r = this.remote;
      let out = r.session.input(raw);
      if (r.session.closed) {
        this.remote = null;
        out += `${out ? '\n' : ''}\n[Connection to ${r.ip} closed by foreign host]`;
      }
      return out;
    }
    const line = raw.trim();
    if (!line) return '';
    this.history.push(line);
    const d = this.net.dev(this.devId);
    if (!d.doc.powered) return '';
    const [cmd = '', ...args] = line.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case '?':
      case 'help':
        return HELP;
      case 'ipconfig':
        return this.ipconfig(args);
      case 'ipv6config':
        return this.ipv6config(args);
      case 'ping':
        return this.ping(args);
      case 'tracert':
      case 'traceroute':
        return this.tracert(args);
      case 'arp':
        return this.arp(args);
      case 'nslookup':
        return this.nslookup(args);
      case 'ftp':
        return this.ftp(args);
      case 'mail':
        return this.mail(args);
      case 'ntp':
        return this.ntp(args);
      case 'telnet':
        return this.connect('telnet', args);
      case 'ssh':
        return this.connect('ssh', args);
      default:
        return 'Invalid Command.';
    }
  }

  private ipconfig(args: string[]): string {
    const d = this.net.dev(this.devId);
    const h = d.host!;
    const sub = args[0]?.toLowerCase();
    if (sub === '/renew') {
      const r = this.net.dhcpRenew(this.devId);
      if (!r.ok) return '\nDHCP request failed. \n' + this.ipconfig([]);
      return this.ipconfig([]);
    }

    if (sub === '/release') {
      if (h.ipMode !== 'dhcp') return 'Operation failed on adapter FastEthernet0: The adapter is not enabled for DHCP.';
      this.net.dhcpRelease(this.devId);
      return this.ipconfig([]);
    }
    if (sub && sub !== '/all') return 'Invalid Command.';
    const ifn = this.net.hostIf(d);
    const up = this.net.portStatus(this.devId, ifn).proto;
    const v6 = this.net.l3Ifs6(d)[0];
    const L = ['', `${ifn} Connection:(default port)`, ''];
    if (!up) {
      L.push('   Media State.....................: Media disconnected');
      return L.join('\n');
    }
    L.push('   Connection-specific DNS Suffix..: ');
    if (sub === '/all') L.push(`   Physical Address................: ${macWindows(d.ports.get(ifn)!.mac)}`, `   DHCP Enabled....................: ${h.ipMode === 'dhcp' ? 'Yes' : 'No'}`);
    L.push(`   Link-local IPv6 Address.........: ${v6 ? ip6ToString(v6.ll) : '::'}`, `   IPv6 Address....................: ${v6?.addrs[0] ? ip6ToString(v6.addrs[0].ip) : '::'}`);
    L.push(`   IPv4 Address....................: ${h.ip || '0.0.0.0'}`, `   Subnet Mask.....................: ${h.mask || '0.0.0.0'}`, `   Default Gateway.................: ${h.ipv6Gateway || '::'}`, `                                     ${h.gateway || '0.0.0.0'}`);
    if (sub === '/all') L.push(`   DHCP Servers....................: ${d.dhcpServer !== undefined ? ipToString(d.dhcpServer) : '0.0.0.0'}`, `   DNS Servers.....................: ${h.dns || '0.0.0.0'}`);
    if (d.ipConflict) L.push('', `   Warning: IP address conflict detected with ${macCisco(d.ipConflict)}`);
    return L.join('\n');
  }

  private ipv6config(args: string[]): string {
    if (args[0]?.toLowerCase() !== '/renew' || args.length !== 1) return 'Usage: ipv6config /renew';
    const result = this.net.ipv6Renew(this.devId);
    if (!result.ok) return 'IPv6 autoconfiguration failed.';
    return `IPv6 address: ${result.ipv6 ?? '::'}\nDefault gateway: ${result.gateway ?? '::'}`;
  }

  private target(name: string): { v4?: number; v6?: bigint; error?: string } {
    if (name.includes(':')) {
      const v6 = parseIp6(name);
      return v6 === null ? { error: `Ping request could not find host ${name}. Please check the name and try again.` } : { v6 };
    }
    const r = this.net.resolveName(this.devId, name);
    if (r.ip === undefined) return { error: `Ping request could not find host ${name}. Please check the name and try again.` };
    return { v4: r.ip };
  }

  private ping(args: string[]): string {
    let count = 4;
    let target: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-n') count = Math.max(1, Math.min(100, Number(args[++i]) || 4));
      else if (a === '-t') count = 100;
      else target = a;
    }
    if (!target) return 'Invalid Command.';
    const t = this.target(target);
    if (t.error) return t.error;
    const shown = t.v6 !== undefined ? ip6ToString(t.v6) : ipToString(t.v4!);
    const L = ['', `Pinging ${shown} with 32 bytes of data:`, ''];
    let received = 0;
    const rtts: number[] = [];
    for (let k = 0; k < count; k++) {
      const o: EchoOutcome = t.v6 !== undefined ? this.net.echo6(this.devId, t.v6, { timeout: 4000 }) : this.net.echo(this.devId, t.v4!, { timeout: 4000 });
      const from = t.v6 !== undefined ? shown : 'from' in o ? ipToString(o.from) : shown;
      if (o.kind === 'reply') {
        received++;
        const ms = Math.round(o.rtt);
        rtts.push(ms);
        L.push(`Reply from ${t.v6 !== undefined ? shown : ipToString(o.from)}: bytes=32 time${ms < 1 ? '<1' : '='}${ms < 1 ? '' : ms}ms TTL=${o.ttl}`);
      } else if (o.kind === 'unreachable') {
        received++;
        L.push(`Reply from ${from}: Destination host unreachable.`);
      } else if (o.kind === 'ttl-exceeded') {
        received++;
        L.push(`Reply from ${from}: TTL expired in transit.`);
      } else L.push('Request timed out.');
    }
    const lost = count - received;
    L.push('', `Ping statistics for ${shown}:`, `    Packets: Sent = ${count}, Received = ${received}, Lost = ${lost} (${Math.round((lost * 100) / count)}% loss),`);
    if (rtts.length) L.push('Approximate round trip times in milli-seconds:', `    Minimum = ${Math.min(...rtts)}ms, Maximum = ${Math.max(...rtts)}ms, Average = ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)}ms`);
    return L.join('\n');
  }

  private tracert(args: string[]): string {
    const name = args[args.length - 1];
    if (!name) return 'Invalid Command.';
    const t = this.target(name);
    if (t.error || t.v4 === undefined) return t.error ?? 'Invalid Command.';
    const L = ['', `Tracing route to ${ipToString(t.v4)} over a maximum of 30 hops: `, ''];
    for (let ttl = 1; ttl <= 30; ttl++) {
      const cells: string[] = [];
      let from: number | undefined;
      let done = false;
      for (let k = 0; k < 3; k++) {
        const o = this.net.echo(this.devId, t.v4, { ttl, timeout: 4000 });
        if (o.kind === 'reply' || o.kind === 'ttl-exceeded') {
          from = o.from;
          cells.push(`${Math.round(o.rtt)} ms`.padEnd(10));
          if (o.kind === 'reply') done = true;
        } else if (o.kind === 'unreachable') {
          from = o.from;
          cells.push('*'.padEnd(10));
          done = true;
        } else cells.push('*'.padEnd(10));
      }
      L.push(`${String(ttl).padStart(3)}   ${cells.join('')}${from !== undefined ? ipToString(from) : 'Request timed out.'}`);
      if (done) break;
    }
    L.push('', 'Trace complete.');
    return L.join('\n');
  }

  private arp(args: string[]): string {
    const d = this.net.dev(this.devId);
    if (args[0] === '-d') {
      d.arp.clear();
      return '';
    }
    if (args[0] !== '-a') return 'Invalid Command.';
    const entries = [...d.arp.entries()].filter(([ip]) => this.net.arpLookup(d, ip));
    if (!entries.length) return 'No ARP Entries Found';
    const L = ['  Internet Address      Physical Address      Type'];
    for (const [ip, e] of entries.sort((a, b) => a[0] - b[0])) L.push(`  ${ipToString(ip).padEnd(22)}${macCisco(e.mac).padEnd(22)}dynamic`);
    return L.join('\n');
  }

  private nslookup(args: string[]): string {
    const name = args[0];
    const d = this.net.dev(this.devId);
    const server = d.host!.dns || '0.0.0.0';
    if (!name) return `Server: [${server}]\nAddress: ${server}`;
    const r = this.net.resolveName(this.devId, name);
    const head = `\nServer: [${server}]\nAddress:  ${server}\n`;
    if (r.ip !== undefined) return `${head}\nNon-authoritative answer:\nName:   ${name}\nAddress:  ${ipToString(r.ip)}`;
    if (r.error === 'nxdomain') return `${head}\n*** ${server} can't find ${name}: Non-existent domain`;
    return `${head}\nDNS request timed out.\n    timeout was 15000 milli seconds.\n*** Request to ${server} timed-out`;
  }

  private ftp(args: string[]): string {
    const [host, rawCommand, file, ...content] = args;
    const command = rawCommand?.toUpperCase();
    if (!host || !['LIST', 'GET', 'PUT'].includes(command ?? '')) return 'Usage: ftp <server> list | get <file> | put <file> <content>';
    if ((command === 'GET' || command === 'PUT') && !file) return 'A file name is required.';
    const address = this.net.resolveName(this.devId, host);
    if (address.ip === undefined) return 'Host Name Unresolved';
    const payload = command === 'LIST'
      ? { app: 'ftp' as const, command: 'LIST' as const }
      : command === 'GET'
        ? { app: 'ftp' as const, command: 'RETR' as const, file }
        : { app: 'ftp' as const, command: 'STOR' as const, file, content: content.join(' ') };
    const result = this.net.tcpTransaction(this.devId, address.ip, 21, payload);
    if (result.kind !== 'data' || result.data.app !== 'ftp') return result.kind === 'reset' ? 'FTP service unavailable.' : 'FTP request timed out.';
    if (result.data.error) return `FTP error: ${result.data.error}`;
    if (result.data.command === 'LIST') return (result.data.files ?? []).join('\n') || 'No files.';
    if (result.data.command === 'RETR') return result.data.content ?? '';
    return result.data.response ?? 'File stored.';
  }

  private mail(args: string[]): string {
    const [host, rawCommand, ...rest] = args;
    const command = rawCommand?.toLowerCase();
    if (!host || !['send', 'check'].includes(command ?? '')) return 'Usage: mail <server> send <from> <to> <subject> <body> | check <mailbox> [message number]';
    const address = this.net.resolveName(this.devId, host);
    if (address.ip === undefined) return 'Host Name Unresolved';
    if (command === 'send') {
      const [from, to, subject, ...body] = rest;
      if (!from || !to || !subject || !body.length) return 'Usage: mail <server> send <from> <to> <subject> <body>';
      const result = this.net.tcpTransaction(this.devId, address.ip, 25, { app: 'smtp', command: 'SEND', from, to, subject, body: body.join(' ') });
      if (result.kind !== 'data' || result.data.app !== 'smtp') return result.kind === 'reset' ? 'SMTP service unavailable.' : 'SMTP request timed out.';
      return result.data.accepted ? 'Message accepted by SMTP server.' : `SMTP error: ${result.data.reason ?? 'message rejected'}`;
    }
    const [mailbox, rawIndex] = rest;
    if (!mailbox) return 'Usage: mail <server> check <mailbox> [message number]';
    const index = rawIndex === undefined ? undefined : Number(rawIndex);
    if (index !== undefined && (!Number.isInteger(index) || index < 1)) return 'Message number must be a positive integer.';
    const result = this.net.tcpTransaction(this.devId, address.ip, 110, { app: 'pop3', command: index ? 'RETR' : 'LIST', mailbox, ...(index ? { index } : {}) });
    if (result.kind !== 'data' || result.data.app !== 'pop3') return result.kind === 'reset' ? 'POP3 service unavailable.' : 'POP3 request timed out.';
    if (result.data.error) return `POP3 error: ${result.data.error}`;
    if (result.data.message) return `From: ${result.data.message.from}\nTo: ${result.data.message.to}\nSubject: ${result.data.message.subject}\n\n${result.data.message.body}`;
    return (result.data.messages ?? []).map((m, i) => `${i + 1} ${m.from} ${m.subject}`).join('\n') || 'No messages.';
  }

  private ntp(args: string[]): string {
    const host = args[0];
    if (!host) return 'Usage: ntp <server>';
    const address = this.net.resolveName(this.devId, host);
    if (address.ip === undefined) return 'Host Name Unresolved';
    const result = this.net.udpRequest(this.devId, address.ip, 123, { app: 'ntp' });
    if (result.kind !== 'data' || result.data.app !== 'ntp') return 'NTP request timed out.';
    if (result.data.serverTime === undefined) return 'NTP server returned an invalid response.';
    return `NTP time synchronized: ${Math.round(result.data.serverTime)} ms (simulation clock).`;
  }

  /** `telnet <host>` / `ssh -l <user> <host>`: TCP connection through the network, then the remote VTY session. */
  private connect(proto: 'telnet' | 'ssh', args: string[]): string {
    let user: string | undefined;
    let host: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-l') user = args[++i];
      else host = args[i];
    }
    if (!host || (proto === 'ssh' && !user)) return proto === 'ssh' ? 'Invalid Command.\nUsage: SSH -l username target' : 'Invalid Command.';
    const r = this.net.resolveName(this.devId, host);
    if (r.ip === undefined) return `% Unknown command or computer name, or unable to find computer address`;
    const ip = ipToString(r.ip);
    const head = proto === 'telnet' ? `Trying ${ip} ...` : '';
    const o = this.net.tcpTransaction(this.devId, r.ip, proto === 'telnet' ? 23 : 22, { app: 'vty', proto, ...(user ? { user } : {}) });
    if (o.kind === 'reset') return `${head}\n% Connection refused by remote host`;
    if (o.kind !== 'data' || o.data.app !== 'vty' || !o.data.accepted) return `${head}\n% Connection timed out; remote host not responding`;
    const target = [...this.net.devices.values()].find((x) => this.net.l3Ifs(x).some((i) => i.ip === o.from));
    if (!target?.ios) return `${head}\n% Connection refused by remote host`;
    const session = new IosSession(this.net, target.doc.id, { vty: { proto, ...(user ? { user } : {}) } });
    const banner = session.openVty();
    if (session.closed) return `${head}${head ? 'Open' : ''}\n${banner}\n\n[Connection to ${ip} closed by foreign host]`;
    this.remote = { session, ip };
    return `${head}${head ? 'Open' : ''}${banner ? `\n${banner}` : ''}`;
  }
}

/** Web browser of the Desktop: http(s)://host/path through DNS + TCP. */
export function browse(net: Network, devId: string, url: string): { status: number; body: string; secure: boolean } | { error: string } {
  const m = /^(?:(https?):\/\/)?([^/\s]+)(\/[^\s]*)?$/i.exec(url.trim());
  if (!m) return { error: 'Invalid URL' };
  const secure = (m[1] ?? 'http').toLowerCase() === 'https';
  const r = net.resolveName(devId, m[2]!);
  if (r.ip === undefined) return { error: 'Host Name Unresolved' };
  const o = net.tcpTransaction(devId, r.ip, secure ? 443 : 80, { app: 'http', method: 'GET', path: m[3] ?? '/' });
  if (o.kind === 'data' && o.data.app === 'http') return { status: o.data.status ?? 200, body: o.data.body ?? '', secure };
  if (o.kind === 'reset') return { error: 'Server Reset Connection' };
  return { error: 'Request Timeout' };
}

void parseIp;

const HELP = `Available Commands:
?         Display the list of available commands
arp       Display the arp table (arp -a, arp -d)
help      Display the list of available commands
ipconfig  Display network configuration (ipconfig /all, /renew, /release)
nslookup  DNS lookup
ftp       FTP client (ftp <server> list|get|put)
mail      SMTP/POP3 client (mail <server> send|check)
ntp       Synchronize with an NTP server
ping      Send echo messages (ping [-n count] [-t] address|name|ipv6)
ssh       Ssh client (ssh -l username target)
telnet    Telnet client
tracert   Trace route to destination`;
