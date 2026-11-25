import { ipToString } from '../net/ipv4';
import { ip6ToString } from '../net/ipv6';
import { macCisco } from '../net/mac';

export interface ArpPkt {
  op: 1 | 2;
  sha: string;
  spa: number;
  tha: string;
  tpa: number;
}

/** Summary of the offending datagram carried inside ICMP error messages. */
export interface IpQuote {
  src: number;
  dst: number;
  proto: IpProto;
  ident?: number;
  seq?: number;
  sport?: number;
  dport?: number;
}

export interface IcmpPkt {
  type: number;
  code: number;
  ident: number;
  seq: number;
  quote?: IpQuote;
}

/** DHCP message (RFC 2131 fields that matter for the simulation). */
export interface DhcpMsg {
  op: 'DISCOVER' | 'OFFER' | 'REQUEST' | 'ACK' | 'NAK' | 'RELEASE';
  xid: number;
  chaddr: string;
  ciaddr: number;
  yiaddr: number;
  giaddr: number;
  server?: number;
  mask?: number;
  router?: number;
  dns?: number;
}

export interface Dhcp6Msg {
  op: 'SOLICIT' | 'ADVERTISE' | 'REQUEST' | 'REPLY';
  xid: number;
  clientMac: string;
  address?: bigint;
  prefix?: { network: bigint; len: number };
  dns?: bigint;
}

export interface DnsMsg {
  id: number;
  qname: string;
  response?: boolean;
  answer?: number;
  rcode?: 'NOERROR' | 'NXDOMAIN';
}

export interface TftpMsg {
  op: 'RRQ' | 'WRQ' | 'DATA' | 'ERROR';
  file: string;
  content?: string;
  error?: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface RipRoute {
  network: number;
  mask: number;
  metric: number;
}

export interface OspfControlMessage {
  type: 'HELLO' | 'LSA';
  routerId: number;
  area: number;
  mask?: number;
  networks?: { network: number; mask: number; metric: number }[];
}

export interface Ospf6ControlMessage {
  type: 'HELLO' | 'LSA';
  routerId: number;
  area: number;
  prefixes?: { prefix: bigint; len: number; metric: number }[];
}

/** Application payloads carried by UDP/TCP. */
export type AppData =
  | { app: 'dhcp'; dhcp: DhcpMsg }
  | { app: 'dhcp6'; dhcp6: Dhcp6Msg }
  | { app: 'dns'; dns: DnsMsg }
  | { app: 'tftp'; tftp: TftpMsg }
  | { app: 'http'; method?: string; path?: string; status?: number; body?: string; secure?: boolean }
  | { app: 'ftp'; command: 'LIST' | 'RETR' | 'STOR'; file?: string; content?: string; files?: string[]; response?: string; error?: string }
  | ({ app: 'smtp'; command: 'SEND'; accepted?: boolean; reason?: string } & MailMessage)
  | { app: 'pop3'; command: 'LIST' | 'RETR'; mailbox: string; index?: number; messages?: { from: string; subject: string }[]; message?: MailMessage; error?: string }
  | { app: 'ntp'; serverTime?: number }
  | { app: 'rip'; version: 1 | 2; routes: RipRoute[] }
  | { app: 'vty'; proto: 'telnet' | 'ssh'; user?: string; accepted?: boolean; reason?: string };

export interface UdpPkt {
  sport: number;
  dport: number;
  data?: AppData;
}

export type TcpFlags = 'SYN' | 'SYN-ACK' | 'ACK' | 'PSH-ACK' | 'FIN' | 'FIN-ACK' | 'RST';

export interface TcpSeg {
  sport: number;
  dport: number;
  flags: TcpFlags;
  seq: number;
  ack: number;
  data?: AppData;
}

export type IpProto = 'icmp' | 'udp' | 'tcp' | 'ospf';

export interface Ipv4Pkt {
  src: number;
  dst: number;
  ttl: number;
  proto: IpProto;
  id: number;
  icmp?: IcmpPkt;
  udp?: UdpPkt;
  tcp?: TcpSeg;
  ospf?: OspfControlMessage;
}

/** IPv6 datagram (ICMPv6 and UDP for DHCPv6). */
export interface Ipv6Pkt {
  src: bigint;
  dst: bigint;
  hop: number;
  icmp6?: { type: number; code: number; ident?: number; seq?: number; target?: bigint; lladdr?: string; quote?: { ident?: number; seq?: number }; prefix?: { network: bigint; len: number }; managed?: boolean };
  udp?: UdpPkt;
  ospf6?: Ospf6ControlMessage;
}

export interface Frame {
  src: string;
  dst: string;
  /** 802.1Q tag, only present while the frame crosses a trunk. */
  tag?: number;
  type: 'arp' | 'ipv4' | 'ipv6';
  arp?: ArpPkt;
  ip?: Ipv4Pkt;
  ip6?: Ipv6Pkt;
  /** HDLC framing on serial links (no MAC addresses). */
  hdlc?: boolean;
  /** Number of L2 hops so far; guards against unbounded loops when STP cannot break them. */
  hops: number;
}

const APP_PORTS: Record<number, string> = { 67: 'DHCP', 68: 'DHCP', 53: 'DNS', 69: 'TFTP', 80: 'HTTP', 443: 'HTTPS', 23: 'TELNET', 22: 'SSH', 21: 'FTP', 25: 'SMTP', 110: 'POP3', 123: 'NTP', 520: 'RIP' };

export function protoOf(f: Frame): string {
  if (f.type === 'arp') return 'ARP';
  if (f.type === 'ipv6') {
    const p = f.ip6!;
    if (p.ospf6) return 'OSPFv3';
    if (p.udp) return p.udp.data?.app === 'dhcp6' ? 'DHCPv6' : 'UDPv6';
    if (!p.icmp6) return 'IPv6';
    const t = p.icmp6.type;
    return t === 135 || t === 136 || t === 133 || t === 134 ? 'NDP' : 'ICMPv6';
  }
  const p = f.ip!;
  if (p.proto === 'icmp') return 'ICMP';
  if (p.proto === 'ospf') return 'OSPF';
  if (p.udp) return APP_PORTS[p.udp.dport] ?? APP_PORTS[p.udp.sport] ?? 'UDP';
  if (p.tcp) return APP_PORTS[p.tcp.dport] ?? APP_PORTS[p.tcp.sport] ?? 'TCP';
  return p.proto.toUpperCase();
}

export const ICMP_TYPES: Record<number, string> = {
  0: 'Echo Reply',
  3: 'Destination Unreachable',
  8: 'Echo Request',
  11: 'Time Exceeded',
};

const ICMP6_TYPES: Record<number, string> = { 1: 'Destination Unreachable', 3: 'Time Exceeded', 128: 'Echo Request', 129: 'Echo Reply', 135: 'Neighbor Solicitation', 136: 'Neighbor Advertisement' };

export function describeFrame(f: Frame): string {
  if (f.type === 'arp') {
    const a = f.arp!;
    return a.op === 1 ? `ARP Request who-has ${ipToString(a.tpa)} tell ${ipToString(a.spa)}` : `ARP Reply ${ipToString(a.spa)} is-at ${macCisco(a.sha)}`;
  }
  if (f.type === 'ipv6') {
    const p = f.ip6!;
    if (p.ospf6) return `OSPFv3 ${p.ospf6.type} RID ${ipToString(p.ospf6.routerId)} AREA ${p.ospf6.area} ${ip6ToString(p.src)} > ${ip6ToString(p.dst)} HL=${p.hop}`;
    if (p.udp) return `UDPv6 ${p.udp.sport} > ${p.udp.dport}${p.udp.data?.app === 'dhcp6' ? ` DHCPv6 ${p.udp.data.dhcp6.op}` : ''} ${ip6ToString(p.src)} > ${ip6ToString(p.dst)} HL=${p.hop}`;
    if (!p.icmp6) return `IPv6 ${ip6ToString(p.src)} > ${ip6ToString(p.dst)} HL=${p.hop}`;
    const t = ICMP6_TYPES[p.icmp6.type] ?? `type ${p.icmp6.type}`;
    return `ICMPv6 ${t}${p.icmp6.target !== undefined ? ` ${ip6ToString(p.icmp6.target)}` : ''} ${ip6ToString(p.src)} > ${ip6ToString(p.dst)} HL=${p.hop}`;
  }
  const p = f.ip!;
  const head = `${ipToString(p.src)} > ${ipToString(p.dst)} TTL=${p.ttl}`;
  if (p.proto === 'icmp') return `ICMP ${ICMP_TYPES[p.icmp!.type] ?? `type ${p.icmp!.type}`} ${head}`;
  if (p.proto === 'ospf') return `OSPF ${p.ospf!.type} RID ${ipToString(p.ospf!.routerId)} AREA ${p.ospf!.area} ${head}`;
  if (p.udp) {
    const d = p.udp.data;
    const extra = d?.app === 'dhcp' ? ` DHCP ${d.dhcp.op}` : d?.app === 'dns' ? ` DNS ${d.dns.response ? 'response' : 'query'} ${d.dns.qname}` : d?.app === 'tftp' ? ` TFTP ${d.tftp.op} ${d.tftp.file}` : '';
    return `UDP ${p.udp.sport} > ${p.udp.dport}${extra} ${head}`;
  }
  if (p.tcp) {
    const d = p.tcp.data;
    const extra = d?.app === 'http' ? (d.method ? ` ${d.method} ${d.path}` : ` ${d.status}`) : d?.app === 'vty' ? ` ${d.proto.toUpperCase()}` : '';
    return `TCP ${p.tcp.sport} > ${p.tcp.dport} [${p.tcp.flags}]${extra} ${head}`;
  }
  return `${p.proto.toUpperCase()} ${head}`;
}

export function cloneFrame(f: Frame): Frame {
  return structuredClone(f);
}
