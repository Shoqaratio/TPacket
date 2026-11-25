import type { Frame, Ipv4Pkt, Ipv6Pkt, SimEvent } from '@netlab/engine';

const u16 = (v: number) => [(v >>> 8) & 0xff, v & 0xff];
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

function checksum(bytes: number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

function macBytes(mac: string): number[] {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);
  return hex.match(/../g)!.map((v) => Number.parseInt(v, 16));
}

function ipv4Bytes(p: Ipv4Pkt): number[] {
  let transport: number[];
  let protocol: number;
  if (p.icmp) {
    protocol = 1;
    transport = [p.icmp.type, p.icmp.code, 0, 0, ...u16(p.icmp.ident), ...u16(p.icmp.seq)];
    transport.splice(2, 2, ...u16(checksum(transport)));
  } else if (p.udp) {
    protocol = 17;
    transport = [...u16(p.udp.sport), ...u16(p.udp.dport), ...u16(8), 0, 0];
    const pseudo = [...u32(p.src), ...u32(p.dst), 0, protocol, ...u16(transport.length), ...transport];
    const sum = checksum(pseudo) || 0xffff;
    transport.splice(6, 2, ...u16(sum));
  } else if (p.tcp) {
    protocol = 6;
    const flags: Record<string, number> = { FIN: 0x01, SYN: 0x02, RST: 0x04, ACK: 0x10, 'SYN-ACK': 0x12, 'PSH-ACK': 0x18 };
    transport = [
      ...u16(p.tcp.sport), ...u16(p.tcp.dport), ...u32(p.tcp.seq), ...u32(p.tcp.ack),
      0x50, flags[p.tcp.flags] ?? 0, 0xff, 0xff, 0, 0, 0, 0,
    ];
    const pseudo = [...u32(p.src), ...u32(p.dst), 0, protocol, ...u16(transport.length), ...transport];
    transport.splice(16, 2, ...u16(checksum(pseudo)));
  } else {
    throw new Error('Unsupported IPv4 packet');
  }
  const header = [
    0x45, 0, ...u16(20 + transport.length), ...u16(p.id), 0x40, 0,
    p.ttl, protocol, 0, 0, ...u32(p.src), ...u32(p.dst),
  ];
  header.splice(10, 2, ...u16(checksum(header)));
  return [...header, ...transport];
}

function ipv6Bytes(p: Ipv6Pkt): number[] {
  const src = bigintBytes(p.src, 16);
  const dst = bigintBytes(p.dst, 16);
  if (p.udp) {
    const udp = [...u16(p.udp.sport), ...u16(p.udp.dport), ...u16(8), 0, 0];
    const pseudo = [...src, ...dst, ...u32(udp.length), 0, 0, 0, 17, ...udp];
    udp.splice(6, 2, ...u16(checksum(pseudo) || 0xffff));
    return [0x60, 0, 0, 0, ...u16(udp.length), 17, p.hop, ...src, ...dst, ...udp];
  }
  const ic = p.icmp6;
  if (!ic) throw new Error('Unsupported IPv6 packet');
  let body: number[];
  if (ic.type === 133) {
    const mac = ic.lladdr ? macBytes(ic.lladdr) : [];
    body = [0, 0, 0, 0, ...(mac.length ? [1, 1, ...mac] : [])];
  } else if (ic.type === 134) {
    const flags = ic.managed ? 0x80 : 0;
    body = [64, flags, ...u16(1800), ...u32(0), ...u32(0)];
    if (ic.prefix) {
      body.push(3, 4, ic.prefix.len, 0xc0, ...u32(86400), ...u32(14400), ...u32(0), ...bigintBytes(ic.prefix.network, 16));
    }
  } else if (ic.type === 135 || ic.type === 136) {
    const mac = ic.lladdr ? macBytes(ic.lladdr) : [];
    body = [ic.type === 135 ? 0 : 0x60, 0, 0, 0, ...bigintBytes(ic.target ?? 0n, 16), ...(mac.length ? [ic.type === 135 ? 1 : 2, 1, ...mac] : [])];
  } else {
    body = [...u16(ic.ident ?? 0), ...u16(ic.seq ?? 0)];
  }
  const icmp = [ic.type, ic.code, 0, 0, ...body];
  const pseudo = [...src, ...dst, ...u32(icmp.length), 0, 0, 0, 58, ...icmp];
  icmp.splice(2, 2, ...u16(checksum(pseudo)));
  const header = [0x60, 0, 0, 0, ...u16(icmp.length), 58, p.hop, ...src, ...dst];
  return [...header, ...icmp];
}

function bigintBytes(value: bigint, length: number): number[] {
  const out = Array<number>(length).fill(0);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function ethernetBytes(frame: Frame): number[] | null {
  if (frame.hdlc) return null;
  const prefix = [...macBytes(frame.dst), ...macBytes(frame.src)];
  let etherType: number;
  let payload: number[];
  if (frame.type === 'arp') {
    const a = frame.arp!;
    const body = [...u16(1), ...u16(0x0800), 6, 4, ...u16(a.op), ...macBytes(a.sha), ...u32(a.spa), ...macBytes(a.tha), ...u32(a.tpa)];
    etherType = 0x0806;
    payload = body;
  } else if (frame.type === 'ipv4') {
    etherType = 0x0800;
    payload = ipv4Bytes(frame.ip!);
  } else {
    etherType = 0x86dd;
    payload = ipv6Bytes(frame.ip6!);
  }
  const vlan = frame.tag === undefined ? [] : [...u16(0x8100), ...u16(frame.tag & 0x0fff)];
  return [...prefix, ...vlan, ...u16(etherType), ...payload];
}

export function encodePcap(events: SimEvent[]): ArrayBuffer {
  const packets = events.filter((event) => event.kind === 'tx')
    .map((event) => ({ at: event.at, bytes: ethernetBytes(event.frame) }))
    .filter((packet): packet is { at: number; bytes: number[] } => packet.bytes !== null);
  const size = 24 + packets.reduce((total, packet) => total + 16 + packet.bytes.length, 0);
  const buffer = new ArrayBuffer(size);
  const out = new Uint8Array(buffer);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xa1b2c3d4, true);
  view.setUint16(4, 2, true);
  view.setUint16(6, 4, true);
  view.setUint32(16, 65535, true);
  view.setUint32(20, 1, true);
  let offset = 24;
  for (const packet of packets) {
    const seconds = Math.floor(packet.at / 1000);
    const micros = Math.floor((packet.at - seconds * 1000) * 1000);
    view.setUint32(offset, seconds, true);
    view.setUint32(offset + 4, micros, true);
    view.setUint32(offset + 8, packet.bytes.length, true);
    view.setUint32(offset + 12, packet.bytes.length, true);
    out.set(packet.bytes, offset + 16);
    offset += 16 + packet.bytes.length;
  }
  return buffer;
}
