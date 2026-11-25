import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@netlab/engine';
import { encodePcap } from './pcap';

describe('PCAP export', () => {
  it('writes a little-endian Ethernet capture containing transmitted frames only', () => {
    const tx: SimEvent = {
      seq: 1,
      at: 1250,
      device: 'pc0',
      kind: 'tx',
      proto: 'ICMP',
      info: 'echo',
      frame: {
        src: '00:00:00:00:00:01',
        dst: '00:00:00:00:00:02',
        type: 'ipv4',
        ip: { src: 0xc0a8010a, dst: 0xc0a8010b, ttl: 64, proto: 'icmp', id: 7, icmp: { type: 8, code: 0, ident: 1, seq: 1 } },
        hops: 0,
      },
    };
    const drop = { ...tx, seq: 2, kind: 'drop' as const };
    const bytes = encodePcap([tx, drop]);
    const data = new Uint8Array(bytes);
    const view = new DataView(bytes);

    expect([...data.slice(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
    expect(view.getUint16(4, true)).toBe(2);
    expect(view.getUint16(6, true)).toBe(4);
    expect(view.getUint32(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(1);
    expect(view.getUint32(28, true)).toBe(250_000);
    expect(view.getUint32(32, true)).toBe(42);
    expect([...data.slice(52, 54)]).toEqual([0x08, 0x00]);
  });

  it('encodes IPv6 control and UDP frames with Ethernet framing', () => {
    const event: SimEvent = {
      seq: 3,
      at: 0,
      device: 'pc0',
      kind: 'tx',
      proto: 'UDPv6',
      info: 'request',
      frame: {
        src: '00:00:00:00:00:01',
        dst: '33:33:00:01:00:02',
        type: 'ipv6',
        ip6: { src: 0xfe800000000000000000000000000001n, dst: 0xff02000000000000000000010002n, hop: 1, udp: { sport: 546, dport: 547 } },
        hops: 0,
      },
    };
    const data = new Uint8Array(encodePcap([event]));
    expect([...data.slice(52, 54)]).toEqual([0x86, 0xdd]);
    expect(data[54]).toBe(0x60);
    expect(data[60]).toBe(17);
    expect(data[94]).toBe(0x02);
  });

  it('preserves 802.1Q tags in Ethernet frames', () => {
    const event: SimEvent = {
      seq: 4,
      at: 0,
      device: 'pc0',
      kind: 'tx',
      proto: 'ARP',
      info: 'request',
      frame: {
        src: '00:00:00:00:00:01',
        dst: 'ff:ff:ff:ff:ff:ff',
        tag: 37,
        type: 'arp',
        arp: { op: 1, sha: '00:00:00:00:00:01', spa: 0xc0a80101, tha: '00:00:00:00:00:00', tpa: 0xc0a80102 },
        hops: 0,
      },
    };
    const data = new Uint8Array(encodePcap([event]));
    expect([...data.slice(52, 58)]).toEqual([0x81, 0x00, 0x00, 37, 0x08, 0x06]);
  });
});
