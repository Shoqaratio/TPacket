import { describe, expect, it } from 'vitest';
import { FORWARD_DELAY, parseIp } from '../src';
import { cli, lan, newNet, pc, pingOk, setHost, twoRouters } from './helpers';

describe('layer 1', () => {
  it('a crossover cable between a PC and a switch does not come up', () => {
    const net = newNet();
    const sw = net.addDevice('2960-24TT', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    net.addLink('crossover', { device: a.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/1' });
    expect(net.portStatus(a.id, 'FastEthernet0').l1).toBe(false);
    expect(net.light(a.id, 'FastEthernet0')).toBe('red');
  });

  it('rejects a cable that does not fit the ports', () => {
    const net = newNet();
    const sw = net.addDevice('2960-24TT', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    expect(() => net.addLink('serial-dce', { device: a.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/1' })).toThrow(/does not fit/);
  });

  it('switch ports go through listening/learning before forwarding (amber then green)', () => {
    const net = newNet();
    const sw = net.addDevice('2960-24TT', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/1' });
    expect(net.light(sw.id, 'FastEthernet0/1')).toBe('amber');
    net.advance(2 * FORWARD_DELAY + 1);
    expect(net.light(sw.id, 'FastEthernet0/1')).toBe('green');
  });

  it('router interfaces stay down until no shutdown', () => {
    const { net, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'int g0/0', 'shutdown', 'end']);
    expect(net.ifStatus(net.dev(r0.id), 'GigabitEthernet0/0').adminDown).toBe(true);
  });

  it('serial line protocol needs a clock rate on the DCE end', () => {
    const { net, r0, r1 } = twoRouters();
    expect(net.ifStatus(net.dev(r1.id), 'Serial0/0/0').proto).toBe(true);
    cli(net, r0.id, ['enable', 'conf t', 'int s0/0/0', 'no clock rate', 'end']);
    const st = net.ifStatus(net.dev(r1.id), 'Serial0/0/0');
    expect(st.l1).toBe(true);
    expect(st.proto).toBe(false);
  });
});

describe('ethernet, ARP and switching', () => {
  it('two PCs on a switch can ping and learn each other via ARP', () => {
    const { net, a, b, sw } = lan();
    const out = pc(net, a.id, 'ping 192.168.1.11');
    expect(out).toContain('Reply from 192.168.1.11: bytes=32');
    expect(out).toContain('Received = 4');
    expect(net.dev(a.id).arp.get(parseIp('192.168.1.11')!)?.mac).toBe(net.dev(b.id).ports.get('FastEthernet0')!.mac);
    const mac = cli(net, sw.id, ['enable', 'show mac address-table']);
    expect(mac).toContain('Fa0/1');
    expect(mac).toContain('Fa0/2');
  });

  it('nothing works before STP forwarding: no false positive because of the drawn cable', () => {
    const net = newNet();
    const sw = net.addDevice('2960-24TT', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const b = net.addDevice('PC', 0, 0);
    net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/1' });
    net.addLink('straight', { device: b.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/2' });
    setHost(net, a.id, '192.168.1.10', '255.255.255.0');
    setHost(net, b.id, '192.168.1.11', '255.255.255.0');
    expect(net.echo(a.id, parseIp('192.168.1.11')!, { timeout: 100 }).kind).toBe('timeout');
  });

  it('wrong subnet mask: hosts on different subnets cannot talk without a router', () => {
    const { net, a, b } = lan();
    setHost(net, b.id, '192.168.2.11', '255.255.255.0', '');
    expect(pingOk(net, a.id, '192.168.2.11')).toBe(false);
  });

  it('detects an IP address conflict', () => {
    const { net, a, b } = lan();
    setHost(net, b.id, '192.168.1.10', '255.255.255.0');
    net.converge(1000);
    expect(net.dev(a.id).ipConflict ?? net.dev(b.id).ipConflict).toBeTruthy();
  });

  it('STP blocks a redundant link between two switches and traffic still flows', () => {
    const net = newNet();
    const s0 = net.addDevice('2960-24TT', 0, 0);
    const s1 = net.addDevice('2960-24TT', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const b = net.addDevice('PC', 0, 0);
    net.addLink('crossover', { device: s0.id, port: 'FastEthernet0/23' }, { device: s1.id, port: 'FastEthernet0/23' });
    net.addLink('crossover', { device: s0.id, port: 'FastEthernet0/24' }, { device: s1.id, port: 'FastEthernet0/24' });
    net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: s0.id, port: 'FastEthernet0/1' });
    net.addLink('straight', { device: b.id, port: 'FastEthernet0' }, { device: s1.id, port: 'FastEthernet0/1' });
    setHost(net, a.id, '10.1.1.1', '255.255.255.0');
    setHost(net, b.id, '10.1.1.2', '255.255.255.0');
    net.converge();
    const states = ['FastEthernet0/23', 'FastEthernet0/24'].flatMap((p) => [net.stpState(net.dev(s0.id), p, 1), net.stpState(net.dev(s1.id), p, 1)]);
    expect(states.filter((s) => s === 'BLK')).toHaveLength(1);
    expect(pingOk(net, a.id, '10.1.1.2')).toBe(true);
    expect(net.log.some((e) => e.reason?.code === 'l2_loop')).toBe(false);
  });
});

describe('routing', () => {
  it('static routes give end-to-end connectivity over a serial WAN; TTL is decremented per hop', () => {
    const { net, p0 } = twoRouters();
    const out = pc(net, p0.id, 'ping 192.168.2.10');
    expect(out).toMatch(/Reply from 192\.168\.2\.10: bytes=32 time.*TTL=126/);
  });

  it('a missing route is diagnosed at the router that drops the packet', () => {
    const { net, p0, r0 } = twoRouters({ routes: false });
    const out = pc(net, p0.id, 'ping 192.168.2.10');
    expect(out).toContain('Reply from 192.168.1.1: Destination host unreachable.');
    const drop = net.log.find((e) => e.kind === 'drop' && e.reason?.code === 'no_route');
    expect(drop?.device).toBe(r0.id);
    expect(drop?.reason?.params?.dst).toBe('192.168.2.10');
  });

  it('the reply path matters: a route on one router only is not enough', () => {
    const { net, p0, r1 } = twoRouters();
    cli(net, r1.id, ['enable', 'conf t', 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(false);
  });

  it('a default route works and longest prefix wins', () => {
    const { net, p0, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(true);
    const rt = cli(net, r0.id, ['enable', 'show ip route']);
    expect(rt).toContain('Gateway of last resort is 10.0.0.2 to network 0.0.0.0');
    expect(rt).toContain('S*   0.0.0.0/0 [1/0] via 10.0.0.2');
    // A more specific bogus route must win over the default.
    cli(net, r0.id, ['enable', 'conf t', 'ip route 192.168.2.0 255.255.255.128 10.0.0.2', 'end']);
    expect(net.resolve(net.dev(r0.id), parseIp('192.168.2.10')!)?.route?.mask).toBe(parseIp('255.255.255.128'));
  });

  it('wrong default gateway on a PC breaks remote access but not local', () => {
    const { net, p0 } = twoRouters();
    setHost(net, p0.id, '192.168.1.10', '255.255.255.0', '192.168.1.254');
    expect(pingOk(net, p0.id, '192.168.1.1')).toBe(true);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(false);
  });

  it('IOS ping drops the first echo while ARP resolves (.!!!!)', () => {
    const { net, r0 } = twoRouters();
    const out = cli(net, r0.id, ['enable', 'ping 192.168.1.10']);
    expect(out).toContain('.!!!!');
    expect(out).toContain('Success rate is 80 percent (4/5)');
  });

  it('traceroute lists every hop', () => {
    const { net, r0, p0 } = twoRouters();
    const out = cli(net, r0.id, ['enable', 'traceroute 192.168.2.10']);
    expect(out).toMatch(/1 10\.0\.0\.2/);
    expect(out).toMatch(/2 .*192\.168\.2\.10/);
    const tr = pc(net, p0.id, 'tracert 192.168.2.10');
    expect(tr).toMatch(/1 .*192\.168\.1\.1/);
    expect(tr).toMatch(/3 .*192\.168\.2\.10/);
  });

  it('floating static route takes over when the primary path disappears', () => {
    const { net, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'ip route 192.168.2.0 255.255.255.0 192.168.1.200 200', 'end']);
    const d = net.dev(r0.id);
    expect(net.routes(d).filter((r) => r.type === 'S' && r.network === parseIp('192.168.2.0')).map((r) => r.ad)).toEqual([1]);
    cli(net, r0.id, ['enable', 'conf t', 'int s0/0/0', 'shutdown', 'end']);
    expect(net.routes(d).find((r) => r.type === 'S' && r.network === parseIp('192.168.2.0'))?.ad).toBe(200);
  });
});

describe('VLANs and inter-VLAN routing', () => {
  function vlanLab() {
    const net = newNet();
    const sw = net.addDevice('2960-24TT', 0, 0);
    const r = net.addDevice('2911', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const b = net.addDevice('PC', 0, 0);
    const c = net.addDevice('PC', 0, 0);
    net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/1' });
    net.addLink('straight', { device: b.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/2' });
    net.addLink('straight', { device: c.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/3' });
    net.addLink('straight', { device: r.id, port: 'GigabitEthernet0/0' }, { device: sw.id, port: 'GigabitEthernet0/1' });
    cli(net, sw.id, ['enable', 'conf t', 'vlan 10', 'name ADMIN', 'vlan 20', 'name COMPTA', 'exit',
      'int range fa0/1 - 2', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'int fa0/3', 'switchport mode access', 'switchport access vlan 20', 'end']);
    setHost(net, a.id, '192.168.10.10', '255.255.255.0', '192.168.10.1');
    setHost(net, b.id, '192.168.10.11', '255.255.255.0', '192.168.10.1');
    setHost(net, c.id, '192.168.20.10', '255.255.255.0', '192.168.20.1');
    net.converge();
    return { net, sw, r, a, b, c };
  }

  it('same VLAN communicates, different VLANs are isolated', () => {
    const { net, a, c } = vlanLab();
    expect(pingOk(net, a.id, '192.168.10.11')).toBe(true);
    setHost(net, c.id, '192.168.10.20', '255.255.255.0');
    net.converge(1000);
    expect(pingOk(net, a.id, '192.168.10.20')).toBe(false);
  });

  it('show vlan brief lists access ports per VLAN', () => {
    const { net, sw } = vlanLab();
    const out = cli(net, sw.id, ['show vlan brief']);
    expect(out).toMatch(/10\s+ADMIN\s+active\s+Fa0\/1, Fa0\/2/);
    expect(out).toMatch(/20\s+COMPTA\s+active\s+Fa0\/3/);
  });

  it('router-on-a-stick routes between VLANs only once the switch port is a trunk', () => {
    const { net, sw, r, a, c } = vlanLab();
    cli(net, r.id, ['enable', 'conf t', 'int g0/0', 'no shut',
      'int g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0',
      'int g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0', 'end']);
    net.converge();
    expect(pingOk(net, a.id, '192.168.20.10')).toBe(false); // switch port is still access (DTP does not negotiate with a router)
    cli(net, sw.id, ['enable', 'conf t', 'int g0/1', 'switchport mode trunk', 'end']);
    net.converge();
    expect(pingOk(net, a.id, '192.168.20.10')).toBe(true);
    expect(pc(net, c.id, 'ping 192.168.10.10')).toContain('TTL=127');
    expect(cli(net, sw.id, ['show interfaces trunk'])).toMatch(/Gig0\/1|Gi0\/1/);
  });

  it('removing a VLAN from the trunk allowed list breaks that VLAN only', () => {
    const { net, sw, r, a, b } = vlanLab();
    cli(net, r.id, ['enable', 'conf t', 'int g0/0', 'no shut', 'int g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'int g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0', 'end']);
    cli(net, sw.id, ['enable', 'conf t', 'int g0/1', 'switchport mode trunk', 'switchport trunk allowed vlan 20', 'end']);
    net.converge();
    expect(pingOk(net, a.id, '192.168.10.1')).toBe(false);
    expect(pingOk(net, b.id, '192.168.10.10')).toBe(true);
  });

  it('a multilayer switch routes between SVIs once ip routing is enabled', () => {
    const net = newNet();
    const ml = net.addDevice('3560-24PS', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const c = net.addDevice('PC', 0, 0);
    net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: ml.id, port: 'FastEthernet0/1' });
    net.addLink('straight', { device: c.id, port: 'FastEthernet0' }, { device: ml.id, port: 'FastEthernet0/2' });
    cli(net, ml.id, ['enable', 'conf t', 'vlan 10', 'vlan 20', 'exit', 'int fa0/1', 'switchport access vlan 10', 'int fa0/2', 'switchport access vlan 20',
      'int vlan 10', 'ip address 192.168.10.1 255.255.255.0', 'no shut', 'int vlan 20', 'ip address 192.168.20.1 255.255.255.0', 'no shut', 'end']);
    setHost(net, a.id, '192.168.10.10', '255.255.255.0', '192.168.10.1');
    setHost(net, c.id, '192.168.20.10', '255.255.255.0', '192.168.20.1');
    net.converge();
    expect(pingOk(net, a.id, '192.168.20.10')).toBe(false);
    cli(net, ml.id, ['enable', 'conf t', 'ip routing', 'end']);
    expect(pingOk(net, a.id, '192.168.20.10')).toBe(true);
  });
});

describe('ACL', () => {
  it('a standard ACL blocks one host and counts matches', () => {
    const { net, r1, p0, s0 } = twoRouters();
    const extra = net.addDevice('PC', 0, 0);
    net.addLink('straight', { device: extra.id, port: 'FastEthernet0' }, { device: s0.id, port: 'FastEthernet0/2' });
    setHost(net, extra.id, '192.168.1.20', '255.255.255.0', '192.168.1.1');
    net.converge();
    cli(net, r1.id, ['enable', 'conf t', 'access-list 1 deny host 192.168.1.10', 'access-list 1 permit any', 'int g0/0', 'ip access-group 1 out', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(false);
    expect(pingOk(net, extra.id, '192.168.2.10')).toBe(true);
    expect(net.log.some((e) => e.reason?.code === 'acl_out' && e.device === r1.id)).toBe(true);
    expect(cli(net, r1.id, ['enable', 'show access-lists'])).toMatch(/10 deny host 192\.168\.1\.10 \(\d+ match\(es\)\)/);
  });

  it('extended ACL with implicit deny blocks ICMP', () => {
    const { net, r0, p0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'access-list 100 permit tcp any any eq 80', 'int g0/0', 'ip access-group 100 in', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(false);
  });
});

describe('editor operations', () => {
  it('duplicate clones configuration and internal links, but not PC addresses', () => {
    const { net, sw, a, b } = lan();
    cli(net, sw.id, ['enable', 'conf t', 'hostname CORE', 'end']);
    const ids = net.duplicate([sw.id, a.id], 50, 50);
    expect(ids).toHaveLength(2);
    expect(net.dev(ids[0]!).ios!.hostname).toBe('CORE');
    expect(net.dev(ids[1]!).host!.ip).toBe('');
    expect(net.doc.links.filter((l) => ids.includes(l.a.device) && ids.includes(l.b.device))).toHaveLength(1);
    expect(net.dev(ids[0]!).doc.macBase).not.toBe(net.dev(sw.id).doc.macBase);
    void b;
  });

  it('modules can only be changed while powered off, and removing one unplugs its cables', () => {
    const { net, r0 } = twoRouters();
    expect(() => net.setModule(r0.id, 'EHWIC0', null)).toThrow(/Turn the device off/);
    net.setPower(r0.id, false);
    net.setModule(r0.id, 'EHWIC0', null);
    expect(net.doc.links.some((l) => l.a.port.startsWith('Serial') && (l.a.device === r0.id || l.b.device === r0.id))).toBe(false);
  });

  it('power cycling loses unsaved running-config', () => {
    const { net, r0 } = twoRouters();
    net.setPower(r0.id, false);
    net.setPower(r0.id, true);
    expect(net.dev(r0.id).ios!.hostname).toBe('Router');
  });
});
