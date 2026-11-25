import { describe, expect, it } from 'vitest';
import { IosSession, Network, validateProject } from '../src';
import { type5Verify, type7Decode, type7Encode } from '../src/util/secrets';
import { sha256Hex } from '../src/util/sha256';
import { cli, newNet, twoRouters } from './helpers';

function session(model = '1941') {
  const net = newNet();
  const d = net.addDevice(model, 0, 0);
  const s = new IosSession(net, d.id);
  s.input('');
  return { net, d, s };
}

describe('IOS CLI', () => {
  it('walks the modes with abbreviations and dynamic hostname', () => {
    const { s } = session();
    expect(s.prompt()).toBe('Router>');
    s.input('en');
    expect(s.prompt()).toBe('Router#');
    s.input('conf t');
    expect(s.prompt()).toBe('Router(config)#');
    s.input('hostname R1');
    expect(s.prompt()).toBe('R1(config)#');
    s.input('int gi0/0');
    expect(s.prompt()).toBe('R1(config-if)#');
    s.input('exit');
    s.input('line con 0');
    expect(s.prompt()).toBe('R1(config-line)#');
    s.input('end');
    expect(s.prompt()).toBe('R1#');
  });

  it('falls back from a sub-mode to global configuration like IOS', () => {
    const { s } = session();
    s.input('enable');
    s.input('configure terminal');
    s.input('interface g0/0');
    s.input('hostname EDGE');
    expect(s.prompt()).toBe('EDGE(config)#');
  });

  it('reports invalid input with a caret under the offending word', () => {
    const { s } = session();
    s.input('enable');
    s.input('configure terminal');
    const out = s.input('hostnme R1');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(out.split('\n')[0]).toBe(' '.repeat('Router(config)#'.length) + '^');
    expect(s.input('int g0/0 extra')).toContain("% Invalid input");
  });

  it('reports ambiguous and incomplete commands', () => {
    const { s } = session();
    s.input('enable');
    expect(s.input('c')).toContain('% Ambiguous command');
    s.input('conf t');
    expect(s.input('ip address')).toContain('Invalid input'); // not a global command
    s.input('int g0/0');
    expect(s.input('ip address')).toContain('% Incomplete command.');
  });

  it('unknown exec word triggers the DNS translation attempt', () => {
    const { s } = session();
    expect(s.input('foo')).toContain('Translating "foo"...domain server');
  });

  it('provides contextual help and TAB completion', () => {
    const { s } = session();
    s.input('enable');
    expect(s.help('sh')).toBe('show');
    const h = s.help('show ip ');
    expect(h).toContain('interface');
    expect(h).toContain('route');
    expect(s.complete('conf')).toBe('configure ');
    expect(s.complete('show ip int')).toBe('show ip interface ');
    s.input('conf t');
    expect(s.help('interface ')).toContain('GigabitEthernet');
  });

  it('enable secret protects privileged mode', () => {
    const { s, net, d } = session();
    s.input('enable');
    s.input('conf t');
    s.input('enable secret class');
    s.input('end');
    s.input('disable');
    s.input('enable');
    expect(s.prompt()).toBe('Password: ');
    expect(s.isSecretInput()).toBe(true);
    s.input('wrong');
    s.input('class');
    expect(s.prompt()).toBe('Router#');
    expect(type5Verify('class', net.dev(d.id).ios!.enableSecret!)).toBe(true);
    expect(net.runningConfig(net.dev(d.id))).toMatch(/enable secret 5 \$1\$/);
  });

  it('console password and service password-encryption', () => {
    const { s, net, d } = session();
    s.input('enable');
    s.input('conf t');
    s.input('line con 0');
    s.input('password cisco');
    s.input('login');
    s.input('exit');
    s.input('service password-encryption');
    const run = net.runningConfig(net.dev(d.id));
    const m = /password 7 (\S+)/.exec(run);
    expect(m && type7Decode(m[1]!)).toBe('cisco');
    s.input('end');
    s.input('exit');
    s.input('');
    expect(s.prompt()).toBe('Password: ');
    s.input('cisco');
    expect(s.prompt()).toBe('Router>');
  });

  it('running and startup configuration are distinct; reload restores startup', () => {
    const { s, net, d } = session();
    s.input('enable');
    s.input('conf t');
    s.input('hostname SAVED');
    s.input('end');
    expect(s.input('copy running-config startup-config')).toBe('');
    expect(s.prompt()).toBe('Destination filename [startup-config]? ');
    expect(s.input('')).toContain('[OK]');
    s.input('conf t');
    s.input('hostname UNSAVED');
    s.input('end');
    s.input('reload');
    expect(s.prompt()).toContain('Save? [yes/no]');
    s.input('no');
    s.input('');
    expect(net.dev(d.id).ios!.hostname).toBe('SAVED');
  });

  it('erase startup-config then reload returns to factory defaults', () => {
    const { s, net, d } = session();
    s.input('enable');
    s.input('conf t');
    s.input('hostname X1');
    s.input('end');
    s.input('wr');
    s.input('erase startup-config');
    s.input('');
    expect(net.dev(d.id).doc.startup).toBeNull();
    net.reload(d.id);
    expect(net.dev(d.id).ios!.hostname).toBe('Router');
  });

  it('rejects overlapping subnets and network addresses on interfaces', () => {
    const { s } = session();
    for (const l of ['enable', 'conf t', 'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'int g0/1']) s.input(l);
    expect(s.input('ip address 192.168.1.2 255.255.255.0')).toContain('overlaps with GigabitEthernet0/0');
    expect(s.input('ip address 10.0.0.0 255.255.255.0')).toContain('Bad mask');
  });

  it('subinterface needs encapsulation before an IP address', () => {
    const { s } = session();
    for (const l of ['enable', 'conf t', 'int g0/0.10']) s.input(l);
    expect(s.prompt()).toBe('Router(config-subif)#');
    expect(s.input('ip address 10.10.10.1 255.255.255.0')).toContain('IEEE 802.1Q');
    s.input('encapsulation dot1Q 10');
    expect(s.input('ip address 10.10.10.1 255.255.255.0')).toBe('');
  });

  it('switch: access VLAN is created automatically, switchport is refused on routers', () => {
    const { s, net, d } = session('2960-24TT');
    for (const l of ['enable', 'conf t', 'int fa0/5']) s.input(l);
    expect(s.input('switchport access vlan 30')).toContain('Creating vlan 30');
    expect(net.dev(d.id).doc.vlanDb!.map((v) => v.id)).toEqual([30]);
    const r = session('1941');
    for (const l of ['enable', 'conf t', 'int g0/0']) r.s.input(l);
    expect(r.s.input('switchport mode access')).toContain('Invalid input');
  });

  it('crypto key generate rsa requires hostname and domain name', () => {
    const { s, net, d } = session();
    for (const l of ['enable', 'conf t']) s.input(l);
    expect(s.input('crypto key generate rsa')).toContain('hostname other than Router');
    s.input('hostname R1');
    expect(s.input('crypto key generate rsa')).toContain('domain-name');
    s.input('ip domain-name lab.local');
    s.input('crypto key generate rsa');
    expect(s.prompt()).toBe('How many bits in the modulus [512]: ');
    expect(s.input('1024')).toContain('Generating 1024 bit RSA keys');
    expect(net.dev(d.id).doc.rsaModulus).toBe(1024);
    expect(s.input('ip ssh version 2')).toBe('');
  });

  it('interface range applies to every port', () => {
    const { s, net, d } = session('2960-24TT');
    for (const l of ['enable', 'conf t', 'interface range fa0/1-4, fa0/10 - 11', 'shutdown', 'end']) s.input(l);
    const c = net.dev(d.id).ios!;
    expect(['FastEthernet0/1', 'FastEthernet0/4', 'FastEthernet0/10', 'FastEthernet0/11'].every((n) => c.interfaces.get(n)!.shutdown)).toBe(true);
    expect(c.interfaces.get('FastEthernet0/5')!.shutdown).toBe(false);
  });

  it('show ip interface brief reflects real state', () => {
    const { net, r0 } = twoRouters();
    const out = cli(net, r0.id, ['enable', 'show ip interface brief']);
    expect(out).toMatch(/GigabitEthernet0\/0\s+192\.168\.1\.1\s+YES manual up\s+up/);
    expect(out).toMatch(/GigabitEthernet0\/1\s+unassigned\s+YES unset\s+administratively down down/);
    expect(out).toMatch(/Serial0\/0\/0\s+10\.0\.0\.1\s+YES manual up\s+up/);
  });

  it('show cdp neighbors uses the live topology', () => {
    const { net, r0 } = twoRouters();
    const out = cli(net, r0.id, ['enable', 'show cdp neighbors']);
    expect(out).toMatch(/R1\s+Se 0\/0\/0/);
    expect(out).toMatch(/Switch\s+Gig 0\/0/);
  });

  it('system messages are emitted on link changes', () => {
    const { net, r0 } = twoRouters();
    const msgs: string[] = [];
    net.onConsole = (dev, t) => dev === r0.id && msgs.push(t);
    cli(net, r0.id, ['enable', 'conf t', 'int g0/0', 'shutdown', 'end']);
    expect(msgs).toContain('%LINK-5-CHANGED: Interface GigabitEthernet0/0, changed state to administratively down');
    expect(msgs).toContain('%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to down');
  });
});

describe('persistence', () => {
  it('running-config text round-trips through the parser without loss', () => {
    const { net, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'enable secret class', 'username admin privilege 15 secret pass', 'banner motd #Authorized access only#',
      'access-list 10 permit 192.168.1.0 0.0.0.255', 'access-list 110 deny tcp any host 10.0.0.2 eq telnet', 'access-list 110 permit ip any any',
      'int g0/0', 'description LAN', 'ip access-group 110 in', 'line vty 0 4', 'login local', 'transport input ssh', 'end']);
    const doc = structuredClone(net.serialize());
    const before = net.runningConfig(net.dev(r0.id));
    const net2 = new Network(validateProject(doc));
    const d2 = net2.dev(r0.id);
    expect(d2.loadErrors).toEqual([]);
    expect(net2.runningConfig(d2)).toBe(before);
  });

  it('validateProject rejects malformed or oversized documents', () => {
    expect(() => validateProject({ format: 'netlab', schemaVersion: 1, devices: 'x', links: [] })).toThrow();
    expect(() => validateProject({ format: 'netlab', schemaVersion: 1, devices: [{ id: 'd1', model: 'EvilBox', name: 'x', x: 0, y: 0, macBase: '000af3000001' }], links: [] })).toThrow(/Unknown model/);
    expect(() => validateProject({ format: 'netlab', schemaVersion: 1, devices: [], links: [{ id: 'l1', cable: 'straight', a: { device: 'd9', port: 'x' }, b: { device: 'd8', port: 'y' } }] })).toThrow();
  });

  it('invalid lines in a stored configuration are reported, not silently dropped', () => {
    const net = newNet();
    const d = net.addDevice('1941', 0, 0);
    d.running = 'hostname OK\nthis is not ios\ninterface GigabitEthernet0/0\n ip address 1.1.1.1 255.255.255.0\n';
    const net2 = new Network(validateProject(structuredClone(net.doc)));
    expect(net2.dev(d.id).ios!.hostname).toBe('OK');
    expect(net2.dev(d.id).loadErrors).toHaveLength(1);
    expect(net2.dev(d.id).loadErrors[0]).toContain('this is not ios');
  });
});

describe('primitives', () => {
  it('sha256 matches the reference vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('type 7 encoding is reversible and matches the public algorithm', () => {
    expect(type7Encode('cisco', 8)).toBe('0822455D0A16');
    expect(type7Decode('0822455D0A16')).toBe('cisco');
  });
});
