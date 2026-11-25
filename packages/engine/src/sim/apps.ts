/**
 * Application-layer services reached through real UDP/TCP packets:
 * DHCP (IOS pools, Server device, relay via ip helper-address), DNS, TFTP, HTTP/HTTPS,
 * FTP, SMTP/POP3, NTP, and Telnet/SSH listeners on IOS VTY lines.
 */
import { BROADCAST_IP, broadcastOf, isUsableHost, networkOf, parseIp } from '../net/ipv4';
import { BROADCAST_MAC } from '../net/mac';
import type { Network, RtDevice } from './network';
import type { AppData, DhcpMsg, Ipv4Pkt } from './packets';

interface TcpConnection {
  state: 'syn-received' | 'established' | 'closing';
  clientNext: number;
  serverNext: number;
  lastRequestSeq?: number;
  lastResponse?: AppData;
  lastResponseSeq?: number;
  lastResponseAck?: number;
  finAck?: { seq: number; ack: number };
}

export class Apps {
  private tcpConnections = new Map<string, TcpConnection>();

  constructor(private net: Network) {}

  private reply(d: RtDevice, req: Ipv4Pkt, data: AppData): void {
    const u = req.udp!;
    this.net.originate(d, { src: req.dst === BROADCAST_IP ? 0 : req.dst, dst: req.src, ttl: this.net.defaultTtl(d), proto: 'udp', id: this.net.nextIpId(), udp: { sport: u.dport, dport: u.sport, data } });
  }

  /** A UDP datagram for this device. Returns true when a service consumed it. */
  udp(d: RtDevice, inIf: string, p: Ipv4Pkt): boolean {
    const u = p.udp!;
    const data = u.data;
    if (u.dport === 67 && data?.app === 'dhcp') return this.dhcp(d, inIf, p, data.dhcp);
    const svc = d.doc.services;
    if (u.dport === 53 && data?.app === 'dns' && svc?.dns.enabled) {
      const q = data.dns;
      const rec = svc.dns.records.find((r) => r.name === q.qname.toLowerCase());
      const ip = rec ? parseIp(rec.ip) : null;
      this.reply(d, p, { app: 'dns', dns: { id: q.id, qname: q.qname, response: true, ...(ip !== null ? { answer: ip, rcode: 'NOERROR' } : { rcode: 'NXDOMAIN' }) } });
      return true;
    }
    if (u.dport === 69 && data?.app === 'tftp' && svc?.tftp.enabled) {
      const t = data.tftp;
      if (t.op === 'WRQ') {
        svc.tftp.files[t.file.slice(0, 100)] = (t.content ?? '').slice(0, 64 * 1024);
        this.reply(d, p, { app: 'tftp', tftp: { op: 'DATA', file: t.file } });
      } else if (t.op === 'RRQ') {
        const content = svc.tftp.files[t.file];
        this.reply(d, p, { app: 'tftp', tftp: content === undefined ? { op: 'ERROR', file: t.file, error: 'File not found' } : { op: 'DATA', file: t.file, content } });
      }
      return true;
    }
    if (u.dport === 123 && data?.app === 'ntp' && svc?.ntp.enabled) {
      this.reply(d, p, { app: 'ntp', serverTime: this.net.now });
      return true;
    }
    if (u.dport === 520 && data?.app === 'rip') return true;
    return false;
  }

  // ------------------------------------------------------------------------------ DHCP

  private dhcp(d: RtDevice, inIf: string, p: Ipv4Pkt, m: DhcpMsg): boolean {
    const me = this.net.l3Ifs(d);
    // Relay agent receiving the server's answer: broadcast it on the client's segment.
    if ((m.op === 'OFFER' || m.op === 'ACK' || m.op === 'NAK') && m.giaddr) {
      const out = me.find((i) => i.ip === m.giaddr);
      if (!out) return false;
      const pkt: Ipv4Pkt = { src: out.ip, dst: BROADCAST_IP, ttl: 255, proto: 'udp', id: this.net.nextIpId(), udp: { sport: 67, dport: 68, data: { app: 'dhcp', dhcp: m } } };
      this.net.sendFrame(d, out.name, BROADCAST_MAC, pkt);
      return true;
    }
    if (m.op !== 'DISCOVER' && m.op !== 'REQUEST') return false;
    let handled = false;
    const inCfg = d.ios?.interfaces.get(inIf);
    const inIp = me.find((i) => i.name === inIf);
    if (inCfg?.helpers.length && !m.giaddr && inIp) {
      for (const h of inCfg.helpers) {
        this.net.originate(d, { src: inIp.ip, dst: h, ttl: 255, proto: 'udp', id: this.net.nextIpId(), udp: { sport: 67, dport: 67, data: { app: 'dhcp', dhcp: { ...m, giaddr: inIp.ip } } } });
      }
      handled = true;
    }
    const target = m.giaddr || inIp?.ip;
    if (target === undefined) return handled;
    const lease = this.allocate(d, target, m);
    if (!lease) return handled;
    const answer: DhcpMsg = { ...m, op: m.op === 'DISCOVER' ? 'OFFER' : 'ACK', yiaddr: lease.ip, server: inIp?.ip ?? target, mask: lease.mask, ...(lease.router !== undefined ? { router: lease.router } : {}), ...(lease.dns !== undefined ? { dns: lease.dns } : {}) };
    if (m.op === 'REQUEST' && m.yiaddr && m.yiaddr !== lease.ip) answer.op = 'NAK';
    if (answer.op === 'ACK') d.dhcpBindings.set(lease.ip, { mac: m.chaddr, at: this.net.now });
    if (m.giaddr) {
      this.net.originate(d, { src: 0, dst: m.giaddr, ttl: 255, proto: 'udp', id: this.net.nextIpId(), udp: { sport: 67, dport: 67, data: { app: 'dhcp', dhcp: answer } } });
    } else if (inIp) {
      const pkt: Ipv4Pkt = { src: inIp.ip, dst: BROADCAST_IP, ttl: 255, proto: 'udp', id: this.net.nextIpId(), udp: { sport: 67, dport: 68, data: { app: 'dhcp', dhcp: answer } } };
      this.net.sendFrame(d, inIf, BROADCAST_MAC, pkt);
    }
    return true;
  }

  private allocate(d: RtDevice, target: number, m: DhcpMsg): { ip: number; mask: number; router?: number; dns?: number } | null {
    const taken = (ip: number) => {
      const b = d.dhcpBindings.get(ip);
      return (b && b.mac !== m.chaddr) || this.net.l3Ifs(d).some((i) => i.ip === ip);
    };
    const mine = [...d.dhcpBindings].find(([, b]) => b.mac === m.chaddr)?.[0];
    if (d.ios) {
      const pool = [...d.ios.dhcpPools.values()].find((x) => x.network && networkOf(target, x.network.mask) === x.network.ip);
      if (!pool?.network) return null;
      const { ip: net, mask } = pool.network;
      const excluded = (ip: number) => d.ios!.dhcpExcluded.some(([lo, hi]) => ip >= lo && ip <= hi) || ip === pool.router;
      const pick = (ip: number) => networkOf(ip, mask) === net && isUsableHost(ip, mask) && !excluded(ip) && !taken(ip);
      let ip = mine !== undefined && pick(mine) ? mine : undefined;
      if (ip === undefined) for (let a = net + 1; a < broadcastOf(net, mask); a++) if (pick(a)) { ip = a; break; }
      if (ip === undefined) return null;
      return { ip, mask, ...(pool.router !== undefined ? { router: pool.router } : {}), ...(pool.dns !== undefined ? { dns: pool.dns } : {}) };
    }
    const svc = d.doc.services;
    if (!svc?.dhcp.enabled) return null;
    for (const pool of svc.dhcp.pools) {
      const start = parseIp(pool.start);
      const mask = parseIp(pool.mask);
      if (start === null || mask === null || networkOf(target, mask) !== networkOf(start, mask)) continue;
      const ok = (ip: number) => ip >= start && ip < start + pool.max && networkOf(ip, mask) === networkOf(start, mask) && isUsableHost(ip, mask) && !taken(ip) && ip !== parseIp(pool.gateway);
      let ip = mine !== undefined && ok(mine) ? mine : undefined;
      if (ip === undefined) for (let a = start; a < start + pool.max; a++) if (ok(a)) { ip = a; break; }
      if (ip === undefined) return null;
      const router = parseIp(pool.gateway);
      const dns = parseIp(pool.dns);
      return { ip, mask, ...(router !== null ? { router } : {}), ...(dns !== null ? { dns } : {}) };
    }
    return null;
  }

  // ------------------------------------------------------------------------------ TCP

  /** Which application answers on a TCP port of this device, if any. */
  listening(d: RtDevice, port: number): ((data: AppData | undefined) => AppData) | null {
    const svc = d.doc.services;
    if (svc?.http.enabled && (port === 80 || (port === 443 && svc.http.https))) {
      return (data) => {
        const path = data?.app === 'http' && data.path ? (data.path === '/' ? '/index.html' : data.path) : '/index.html';
        const body = svc.http.pages[path];
        return body === undefined
          ? { app: 'http', status: 404, body: '<html><body><h1>404 Not Found</h1></body></html>', secure: port === 443 }
          : { app: 'http', status: 200, body, secure: port === 443 };
      };
    }
    if (svc?.ftp.enabled && port === 21) {
      return (data) => {
        if (data?.app !== 'ftp') return { app: 'ftp', command: 'LIST', error: 'Invalid FTP request' };
        if (data.command === 'LIST') return { app: 'ftp', command: 'LIST', files: Object.keys(svc.ftp.files).sort() };
        if (data.command === 'RETR') {
          const content = data.file ? svc.ftp.files[data.file] : undefined;
          return content === undefined
            ? { app: 'ftp', command: 'RETR', file: data.file, error: 'File not found' }
            : { app: 'ftp', command: 'RETR', file: data.file, content };
        }
        const file = (data.file ?? '').slice(0, 100);
        if (!file) return { app: 'ftp', command: 'STOR', error: 'A file name is required' };
        if (!(file in svc.ftp.files) && Object.keys(svc.ftp.files).length >= 200) return { app: 'ftp', command: 'STOR', error: 'File limit reached' };
        svc.ftp.files[file] = (data.content ?? '').slice(0, 64 * 1024);
        return { app: 'ftp', command: 'STOR', file, response: 'File stored' };
      };
    }
    if (svc?.mail.enabled && port === 25) {
      return (data) => {
        if (data?.app !== 'smtp') return { app: 'smtp', command: 'SEND', from: '', to: '', subject: '', body: '', accepted: false, reason: 'Invalid SMTP request' };
        if (!data.from || !data.to) return { ...data, accepted: false, reason: 'Sender and recipient are required' };
        if (data.from.length > 254 || data.to.length > 254 || data.subject.length > 998 || data.body.length > 64 * 1024) {
          return { ...data, accepted: false, reason: 'Message exceeds the server limits' };
        }
        if (svc.mail.messages.length >= 500) return { ...data, accepted: false, reason: 'Mailbox storage limit reached' };
        svc.mail.messages.push({ from: data.from, to: data.to, subject: data.subject, body: data.body });
        return { ...data, accepted: true };
      };
    }
    if (svc?.mail.enabled && port === 110) {
      return (data) => {
        if (data?.app !== 'pop3') return { app: 'pop3', command: 'LIST', mailbox: '', error: 'Invalid POP3 request' };
        const messages = svc.mail.messages.filter((m) => m.to.toLowerCase() === data.mailbox.toLowerCase());
        if (data.command === 'LIST') return { app: 'pop3', command: 'LIST', mailbox: data.mailbox, messages: messages.map(({ from, subject }) => ({ from, subject })) };
        const index = (data.index ?? 0) - 1;
        const message = messages[index];
        return message
          ? { app: 'pop3', command: 'RETR', mailbox: data.mailbox, index: data.index, message }
          : { app: 'pop3', command: 'RETR', mailbox: data.mailbox, index: data.index, error: 'Message not found' };
      };
    }
    const c = d.ios;
    if (c && d.doc.powered) {
      const t = c.vty.transport;
      if (port === 23 && (t === 'all' || t === 'telnet')) return () => ({ app: 'vty', proto: 'telnet', accepted: true });
      if (port === 22 && (t === 'all' || t === 'ssh') && d.doc.rsaModulus) return () => ({ app: 'vty', proto: 'ssh', accepted: true });
    }
    return null;
  }

  tcp(d: RtDevice, p: Ipv4Pkt): void {
    const t = p.tcp!;
    const handler = this.listening(d, t.dport);
    const send = (flags: 'SYN-ACK' | 'FIN-ACK' | 'RST' | 'PSH-ACK', data?: AppData, seq = t.ack, ack = t.seq + 1) =>
      this.net.originate(d, { src: p.dst, dst: p.src, ttl: this.net.defaultTtl(d), proto: 'tcp', id: this.net.nextIpId(), tcp: { sport: t.dport, dport: t.sport, flags, seq, ack, ...(data ? { data } : {}) } });
    const key = `${p.src}|${t.sport}|${p.dst}|${t.dport}`;
    if (t.flags === 'SYN') {
      if (!handler) return void send('RST', undefined, 5000);
      const current = this.tcpConnections.get(key);
      const conn = current ?? { state: 'syn-received', clientNext: t.seq + 1, serverNext: 5001 };
      this.tcpConnections.set(key, conn);
      return void send('SYN-ACK', undefined, 5000, t.seq + 1);
    }
    const conn = this.tcpConnections.get(key);
    if (t.flags === 'RST') {
      this.tcpConnections.delete(key);
      return;
    }
    if (!handler || !conn) return void send('RST');
    if (t.flags === 'ACK') {
      if (conn.state === 'syn-received' && t.seq === conn.clientNext && t.ack === conn.serverNext) conn.state = 'established';
      else if (conn.state === 'closing' && t.seq === conn.clientNext && t.ack === conn.serverNext) this.tcpConnections.delete(key);
      return;
    }
    if (t.flags === 'PSH-ACK') {
      if (conn.state !== 'established') return void send('RST');
      if (t.seq === conn.lastRequestSeq && t.ack === conn.lastResponseSeq && conn.lastResponse) {
        return void send('PSH-ACK', conn.lastResponse, conn.lastResponseSeq, conn.lastResponseAck);
      }
      if (t.seq !== conn.clientNext || t.ack !== conn.serverNext) return void send('RST');
      const response = handler(t.data);
      conn.lastRequestSeq = t.seq;
      conn.lastResponse = response;
      conn.lastResponseSeq = conn.serverNext;
      conn.lastResponseAck = t.seq + 1;
      conn.clientNext = t.seq + 1;
      conn.serverNext += 1;
      send('PSH-ACK', response, conn.lastResponseSeq, conn.lastResponseAck);
      return;
    }
    if (t.flags === 'FIN') {
      if (conn.state === 'closing' && t.seq === conn.clientNext - 1 && conn.finAck) {
        return void send('FIN-ACK', undefined, conn.finAck.seq, conn.finAck.ack);
      }
      if (conn.state !== 'established' || t.seq !== conn.clientNext || t.ack !== conn.serverNext) return void send('RST');
      conn.finAck = { seq: conn.serverNext, ack: t.seq + 1 };
      conn.clientNext = t.seq + 1;
      conn.serverNext += 1;
      conn.state = 'closing';
      send('FIN-ACK', undefined, conn.finAck.seq, conn.finAck.ack);
    }
  }
}
