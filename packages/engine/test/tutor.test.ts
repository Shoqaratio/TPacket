import { describe, expect, it } from 'vitest';
import { diagnose } from '../src';
import { cli, setHost, twoRouters } from './helpers';

describe('TPacket Tutor', () => {
  it('finds the missing route on the right router and proposes the exact fix', () => {
    const { net, p0, r0 } = twoRouters({ routes: false });
    const d = diagnose(net, p0.id, '192.168.2.10');
    expect(d.code).toBe('no_route');
    expect(d.device).toBe('Router0');
    expect(d.hints[0]).toContain('Router0');
    expect(d.hints[4]).toContain('ip route 192.168.2.0 255.255.255.0 10.0.0.2');
    cli(net, r0.id, ['enable', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end']);
    const back = diagnose(net, p0.id, '192.168.2.10');
    expect(back.code).toBe('return_path');
    expect(back.device).toBe('Router1');
  });

  it('detects gateway problems, interface down and ACLs, and says OK when fine', () => {
    const { net, p0, r1 } = twoRouters();
    expect(diagnose(net, p0.id, '192.168.2.10').code).toBe('ok');
    setHost(net, p0.id, '192.168.1.10', '255.255.255.0', '');
    const g = diagnose(net, p0.id, '192.168.2.10', 'en');
    expect(g.code).toBe('no_gateway');
    expect(g.hints[4]).toContain('192.168.1.1');
    setHost(net, p0.id, '192.168.1.10', '255.255.255.0', '192.168.1.1');
    cli(net, r1.id, ['enable', 'conf t', 'access-list 5 deny any', 'int g0/0', 'ip access-group 5 out', 'end']);
    const a = diagnose(net, p0.id, '192.168.2.10');
    expect(a.code).toBe('acl');
    expect(a.hints[2]).toContain('ACL 5');
    cli(net, r1.id, ['enable', 'conf t', 'int g0/0', 'no ip access-group 5 out', 'shutdown', 'end']);
    expect(diagnose(net, p0.id, '192.168.2.10').code).toBe('iface_down');
  });
});
