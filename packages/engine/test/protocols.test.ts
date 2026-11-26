import { describe, expect, it } from 'vitest';
import { browse, HostPrompt, parseIp, type EchoOutcome } from '../src';
import { cli, lan, newNet, pc, pingOk, setHost, twoRouters } from './helpers';

/** R0 - R1 - R2 chain with a LAN (switch + PC) behind R0 and R2. */
function chain() {
  const net = newNet();
  const r = [0, 1, 2].map(() => net.addDevice('2911', 0, 0));
  const s0 = net.addDevice('2960-24TT', 0, 0);
  const s2 = net.addDevice('2960-24TT', 0, 0);
  const a = net.addDevice('PC', 0, 0);
  const b = net.addDevice('PC', 0, 0);
  net.addLink('crossover', { device: r[0]!.id, port: 'GigabitEthernet0/1' }, { device: r[1]!.id, port: 'GigabitEthernet0/1' });
  net.addLink('crossover', { device: r[1]!.id, port: 'GigabitEthernet0/2' }, { device: r[2]!.id, port: 'GigabitEthernet0/2' });
  net.addLink('straight', { device: r[0]!.id, port: 'GigabitEthernet0/0' }, { device: s0.id, port: 'GigabitEthernet0/1' });
  net.addLink('straight', { device: r[2]!.id, port: 'GigabitEthernet0/0' }, { device: s2.id, port: 'GigabitEthernet0/1' });
  net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: s0.id, port: 'FastEthernet0/1' });
  net.addLink('straight', { device: b.id, port: 'FastEthernet0' }, { device: s2.id, port: 'FastEthernet0/1' });
  const ifs = [
    ['int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut', 'int g0/1', 'ip address 10.0.12.1 255.255.255.252', 'no shut'],
    ['int g0/1', 'ip address 10.0.12.2 255.255.255.252', 'no shut', 'int g0/2', 'ip address 10.0.23.1 255.255.255.252', 'no shut'],
    ['int g0/0', 'ip address 192.168.3.1 255.255.255.0', 'no shut', 'int g0/2', 'ip address 10.0.23.2 255.255.255.252', 'no shut'],
  ];
  r.forEach((x, i) => cli(net, x.id, ['enable', 'conf t', `hostname R${i}`, ...ifs[i]!, 'end']));
  setHost(net, a.id, '192.168.1.10', '255.255.255.0', '192.168.1.1');
  setHost(net, b.id, '192.168.3.10', '255.255.255.0', '192.168.3.1');
  net.converge();
  return { net, r, a, b };
}

describe('RIP', () => {
  it('RIPv2 learns remote networks across two hops; passive interface stops updates', () => {
    const { net, r, a } = chain();
    expect(pingOk(net, a.id, '192.168.3.10')).toBe(false);
    for (const x of r) cli(net, x.id, ['enable', 'conf t', 'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'network 192.168.1.0', 'network 192.168.3.0', 'end']);
    expect(pingOk(net, a.id, '192.168.3.10')).toBe(true);
    const rt = cli(net, r[0]!.id, ['enable', 'show ip route']);
    expect(rt).toMatch(/R\s+192\.168\.3\.0\/24 \[120\/2\] via 10\.0\.12\.2, GigabitEthernet0\/1/);
    const ripUpdate = net.log.find((event) => event.kind === 'deliver' && event.proto === 'RIP' && event.frame.ip?.udp?.dport === 520);
    expect(ripUpdate?.frame.ip).toMatchObject({ dst: parseIp('224.0.0.9'), ttl: 1, udp: { sport: 520, dport: 520, data: { app: 'rip', version: 2 } } });
    expect(ripUpdate?.frame.ip?.udp?.data).toMatchObject({ routes: expect.arrayContaining([{ network: parseIp('192.168.1.0'), mask: parseIp('255.255.255.0'), metric: 0 }]) });
    const updatesBeforeTimer = net.log.filter((event) => event.kind === 'deliver' && event.proto === 'RIP').length;
    net.advance(30_100);
    expect(net.log.filter((event) => event.kind === 'deliver' && event.proto === 'RIP').length).toBeGreaterThan(updatesBeforeTimer);
    expect(cli(net, r[0]!.id, ['enable', 'show ip protocols'])).toContain('Routing Protocol is "rip"');
    cli(net, r[1]!.id, ['enable', 'conf t', 'router rip', 'passive-interface g0/1', 'end']);
    expect(net.routes(net.dev(r[0]!.id)).some((x) => x.type === 'R' && x.network === parseIp('192.168.3.0'))).toBe(false);
  });

  it('a version mismatch prevents learning', () => {
    const { net, r } = chain();
    cli(net, r[0]!.id, ['enable', 'conf t', 'router rip', 'version 2', 'network 10.0.0.0', 'network 192.168.1.0', 'end']);
    cli(net, r[1]!.id, ['enable', 'conf t', 'router rip', 'version 1', 'network 10.0.0.0', 'end']);
    expect(net.routes(net.dev(r[1]!.id)).some((x) => x.type === 'R')).toBe(false);
  });

  it('RIPv1 sends classful updates as limited broadcasts', () => {
    const { net, r0, r1, p0 } = twoRouters({ routes: false });
    cli(net, r0.id, ['enable', 'conf t', 'router rip', 'version 1', 'network 10.0.0.0', 'network 192.168.1.0', 'end']);
    cli(net, r1.id, ['enable', 'conf t', 'router rip', 'version 1', 'network 10.0.0.0', 'network 192.168.2.0', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(true);
    const update = net.log.find((event) => event.kind === 'deliver' && event.proto === 'RIP');
    expect(update?.frame.ip).toMatchObject({ dst: 0xffffffff, udp: { dport: 520, data: { app: 'rip', version: 1 } } });
  });
});

describe('OSPF', () => {
  it('forms FULL adjacencies, installs O routes; an area mismatch breaks the adjacency', () => {
    const { net, r, a } = chain();
    for (const x of r) cli(net, x.id, ['enable', 'conf t', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'network 192.168.0.0 0.0.255.255 area 0', 'end']);
    expect(pingOk(net, a.id, '192.168.3.10')).toBe(true);
    expect(cli(net, r[0]!.id, ['enable', 'show ip route'])).toMatch(/O\s+192\.168\.3\.0\/24 \[110\/3\] via 10\.0\.12\.2/);
    expect(cli(net, r[1]!.id, ['enable', 'show ip ospf neighbor'])).toMatch(/FULL\/(DR|BDR)/);
    const hello = net.log.find((event) => event.kind === 'deliver' && event.proto === 'OSPF' && event.frame.ip?.ospf?.type === 'HELLO');
    const lsa = net.log.find((event) => event.kind === 'deliver' && event.proto === 'OSPF' && event.frame.ip?.ospf?.type === 'LSA');
    expect(hello?.frame.ip).toMatchObject({ dst: parseIp('224.0.0.5'), ttl: 1, ospf: { type: 'HELLO', area: 0 } });
    expect(lsa?.frame.ip).toMatchObject({ dst: parseIp('224.0.0.5'), ttl: 1, ospf: { type: 'LSA', area: 0 } });
    const hellosBeforeTimer = net.log.filter((event) => event.kind === 'deliver' && event.frame.ip?.ospf?.type === 'HELLO').length;
    net.advance(10_100);
    expect(net.log.filter((event) => event.kind === 'deliver' && event.frame.ip?.ospf?.type === 'HELLO').length).toBeGreaterThan(hellosBeforeTimer);
    cli(net, r[2]!.id, ['enable', 'conf t', 'router ospf 1', 'no network 10.0.0.0 0.255.255.255 area 0', 'network 10.0.0.0 0.255.255.255 area 1', 'end']);
    expect(pingOk(net, a.id, '192.168.3.10')).toBe(false);
  });

  it('OSPF (AD 110) wins over RIP (AD 120)', () => {
    const { net, r } = chain();
    for (const x of r) cli(net, x.id, ['enable', 'conf t', 'router rip', 'version 2', 'network 10.0.0.0', 'network 192.168.3.0', 'router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0', 'end']);
    const route = net.routes(net.dev(r[0]!.id)).find((x) => x.network === parseIp('192.168.3.0'));
    expect(route?.type).toBe('O');
  });
});

describe('DHCP', () => {
  it('automatically retries DHCP for connected hosts after a server is enabled', () => {
    const { net, a, b, sw } = lan();
    const server = net.addDevice('Server', 0, 0);
    net.addLink('straight', { device: server.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/3' });
    setHost(net, server.id, '192.168.1.250', '255.255.255.0', '192.168.1.254');
    for (const client of [a, b]) net.setHostConfig(client.id, { ipMode: 'dhcp' });
    net.advance(45_000);
    for (const client of [a, b]) expect(net.dev(client.id).host!.ip).toMatch(/^169\.254\./);

    const services = server.services!;
    net.setServices(server.id, { ...services, dhcp: { enabled: true, pools: [{
      name: 'LAN', start: '192.168.1.100', mask: '255.255.255.0', max: 100, gateway: '192.168.1.254', dns: '192.168.1.250',
    }] } });
    net.advance(30_000);
    const hosts = [a, b].map((client) => net.dev(client.id).host!);
    expect(hosts.map((host) => host.ip).sort()).toEqual(['192.168.1.100', '192.168.1.101']);
    for (const host of hosts) expect(host).toMatchObject({ mask: '255.255.255.0', gateway: '192.168.1.254', dns: '192.168.1.250' });
    expect(server.host!.ip).toBe('192.168.1.250');
    pc(net, a.id, 'ipconfig /release');
    net.advance(5000);
    expect(net.dev(a.id).host!.ip).toBe('');
    expect(pc(net, a.id, 'ipconfig /renew')).toContain(hosts[0]!.ip);
  });

  it('a PC obtains an address from an IOS pool, skipping excluded addresses', () => {
    const { net, r0, p0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'ip dhcp excluded-address 192.168.1.1 192.168.1.10', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 8.8.8.8', 'end']);
    net.setHostConfig(p0.id, { ip: '', mask: '', gateway: '' });
    const out = pc(net, p0.id, 'ipconfig /renew');
    expect(out).toContain('192.168.1.11');
    expect(net.dev(p0.id).host!.gateway).toBe('192.168.1.1');
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(true);
    expect(cli(net, r0.id, ['enable', 'show ip dhcp binding'])).toContain('192.168.1.11');
  });

  it('relay with ip helper-address reaches a DHCP server on another network', () => {
    const { net, r0, p0, p1 } = twoRouters();
    const srv = net.dev(p1.id); // reuse PC1's place: turn the remote LAN host into a server
    void srv;
    const server = net.addDevice('Server', 0, 0);
    const s1 = net.doc.links.find((l) => l.a.device === p1.id || l.b.device === p1.id)!;
    const sw = s1.a.device === p1.id ? s1.b.device : s1.a.device;
    net.addLink('straight', { device: server.id, port: 'FastEthernet0' }, { device: sw, port: 'FastEthernet0/5' });
    setHost(net, server.id, '192.168.2.100', '255.255.255.0', '192.168.2.1');
    const d = net.dev(server.id).doc;
    d.services!.dhcp = { enabled: true, pools: [{ name: 'LAN1', gateway: '192.168.1.1', dns: '192.168.2.100', start: '192.168.1.50', mask: '255.255.255.0', max: 20 }] };
    net.converge();
    expect(pc(net, p0.id, 'ipconfig /renew')).toContain('DHCP request failed');
    expect(net.dev(p0.id).host!.ip).toMatch(/^169\.254\./);
    cli(net, r0.id, ['enable', 'conf t', 'int g0/0', 'ip helper-address 192.168.2.100', 'end']);
    pc(net, p0.id, 'ipconfig /renew');
    expect(net.dev(p0.id).host!.ip).toBe('192.168.1.50');
    expect(pingOk(net, p0.id, '192.168.2.100')).toBe(true);
  });
});

describe('DNS, HTTP, TFTP', () => {
  function withServer() {
    const t = twoRouters();
    const server = t.net.addDevice('Server', 0, 0);
    const link = t.net.doc.links.find((l) => l.a.device === t.p1.id || l.b.device === t.p1.id)!;
    const sw = link.a.device === t.p1.id ? link.b.device : link.a.device;
    t.net.addLink('straight', { device: server.id, port: 'FastEthernet0' }, { device: sw, port: 'FastEthernet0/5' });
    setHost(t.net, server.id, '192.168.2.100', '255.255.255.0', '192.168.2.1');
    const svc = t.net.dev(server.id).doc.services!;
    svc.dns = { enabled: true, records: [{ name: 'www.netlab.lan', ip: '192.168.2.100' }] };
    svc.http.pages['/index.html'] = '<h1>Intranet</h1>';
    t.net.setHostConfig(t.p0.id, { dns: '192.168.2.100' });
    t.net.converge();
    return { ...t, server };
  }

  it('nslookup, ping by name and the web browser use real DNS and TCP exchanges', () => {
    const { net, p0 } = withServer();
    expect(pc(net, p0.id, 'nslookup www.netlab.lan')).toContain('Address:  192.168.2.100');
    expect(pc(net, p0.id, 'nslookup nope.netlab.lan')).toContain('Non-existent domain');
    expect(pc(net, p0.id, 'ping www.netlab.lan')).toContain('Reply from 192.168.2.100');
    const page = browse(net, p0.id, 'http://www.netlab.lan');
    expect(page).toEqual({ status: 200, body: '<h1>Intranet</h1>', secure: false });
    expect(browse(net, p0.id, 'http://www.netlab.lan/missing.html')).toMatchObject({ status: 404 });
    expect(net.log.some((e) => e.proto === 'DNS') && net.log.some((e) => e.proto === 'HTTP')).toBe(true);
  });

  it('an extended ACL denying www blocks the browser but not ping', () => {
    const { net, p0, r1 } = withServer();
    cli(net, r1.id, ['enable', 'conf t', 'access-list 110 deny tcp any host 192.168.2.100 eq www', 'access-list 110 permit ip any any', 'int g0/0', 'ip access-group 110 out', 'end']);
    expect(browse(net, p0.id, 'http://192.168.2.100')).toEqual({ error: 'Request Timeout' });
    expect(pingOk(net, p0.id, '192.168.2.100')).toBe(true);
  });

  it('named extended ACLs filter traffic, show their type, and survive config replay', async () => {
    const { net, p0, r1 } = withServer();
    cli(net, r1.id, ['enable', 'conf t', 'ip access-list extended WEB', 'deny tcp any host 192.168.2.100 eq www', 'permit ip any any', 'exit', 'int g0/0', 'ip access-group WEB out', 'end']);
    expect(browse(net, p0.id, 'http://192.168.2.100')).toEqual({ error: 'Request Timeout' });
    expect(pingOk(net, p0.id, '192.168.2.100')).toBe(true);
    expect(cli(net, r1.id, ['enable', 'show access-lists'])).toContain('Extended IP access list WEB');
    const { Network, validateProject } = await import('../src');
    const copy = new Network(validateProject(structuredClone(net.serialize())));
    expect(copy.dev(r1.id).loadErrors).toEqual([]);
    expect(copy.runningConfig(copy.dev(r1.id))).toBe(net.runningConfig(net.dev(r1.id)));
  });

  it('complex simulation PDUs exchange TCP handshakes and UDP application messages', () => {
    const { net, p0, server } = withServer();
    const dst = parseIp('192.168.2.100')!;
    expect(pingOk(net, p0.id, '192.168.2.100')).toBe(true);
    const transaction = net.tcpTransaction(p0.id, dst, 80, { app: 'http', method: 'GET', path: '/' });
    expect(transaction).toMatchObject({ kind: 'data', data: { app: 'http', status: 200 } });
    const tcpSegments = net.log.flatMap((event) => {
      const segment = event.frame.ip?.tcp;
      return segment ? [{ device: event.device, flags: segment.flags, seq: segment.seq, ack: segment.ack }] : [];
    });
    expect(tcpSegments.map(({ flags }) => flags)).toEqual(expect.arrayContaining(['SYN', 'SYN-ACK', 'ACK', 'PSH-ACK', 'FIN', 'FIN-ACK']));
    expect(tcpSegments).toContainEqual({ device: p0.id, flags: 'FIN', seq: 1002, ack: 5002 });
    expect(tcpSegments).toContainEqual({ device: server.id, flags: 'FIN-ACK', seq: 5002, ack: 1003 });
    expect(tcpSegments).toContainEqual({ device: p0.id, flags: 'ACK', seq: 1003, ack: 5003 });

    let tcp: EchoOutcome | undefined;
    const tcpSent = net.injectPdu(p0.id, dst, 'tcp', 80, (result) => { tcp = result; });
    expect(tcpSent.sent).toBe(true);
    net.advance(10_000);
    expect(tcp?.kind, JSON.stringify(net.log.map((event) => [event.proto, event.kind, event.info, event.reason?.code]))).toBe('synack');
    expect(net.log.some((event) => event.frame.ip?.tcp?.flags === 'SYN')).toBe(true);

    let udp: EchoOutcome | undefined;
    const udpSent = net.injectPdu(p0.id, dst, 'udp', 53, (result) => { udp = result; });
    expect(udpSent.sent).toBe(true);
    net.advance(10_000);
    expect(udp?.kind).toBe('data');
    expect(net.log.some((event) => event.device === server.id && event.proto === 'DNS')).toBe(true);
  });

  it('rejects TCP application data that arrives without a completed handshake', () => {
    const { net, p0, server } = withServer();
    expect(pingOk(net, p0.id, '192.168.2.100')).toBe(true);
    net.originate(net.dev(p0.id), {
      src: 0, dst: parseIp('192.168.2.100')!, ttl: 64, proto: 'tcp', id: 7000,
      tcp: { sport: 50000, dport: 80, flags: 'PSH-ACK', seq: 1001, ack: 5001, data: { app: 'http', method: 'GET', path: '/' } },
    });
    net.advance(10_000);
    expect(net.log.some((event) => event.device === server.id && event.frame.ip?.tcp?.flags === 'RST'), JSON.stringify(net.log.map((event) => [event.device, event.kind, event.proto, event.info, event.reason?.code]))).toBe(true);
  });

  it('copy running-config tftp then copy tftp running-config', () => {
    const { net, r0, server } = withServer();
    cli(net, r0.id, ['enable', 'conf t', 'banner motd #saved#', 'end']);
    const out = cli(net, r0.id, ['enable', 'copy running-config tftp', '192.168.2.100', '']);
    expect(out).toContain('[OK - ');
    expect(Object.keys(net.dev(server.id).doc.services!.tftp.files)).toContain('r0-confg');
    cli(net, r0.id, ['enable', 'conf t', 'no banner motd', 'end']);
    cli(net, r0.id, ['enable', 'copy tftp running-config', '192.168.2.100', 'r0-confg', '']);
    expect(net.dev(r0.id).ios!.bannerMotd).toBe('saved');
  });
});

describe('FTP, SMTP, POP3 and NTP', () => {
  it('transfers files, sends and retrieves mail, and serves the simulation clock', async () => {
    const t = twoRouters();
    const server = t.net.addDevice('Server', 0, 0);
    const link = t.net.doc.links.find((l) => l.a.device === t.p1.id || l.b.device === t.p1.id)!;
    const sw = link.a.device === t.p1.id ? link.b.device : link.a.device;
    t.net.addLink('straight', { device: server.id, port: 'FastEthernet0' }, { device: sw, port: 'FastEthernet0/5' });
    setHost(t.net, server.id, '192.168.2.100', '255.255.255.0', '192.168.2.1');
    t.net.converge();
    const services = t.net.dev(server.id).doc.services!;
    services.ftp.files['welcome.txt'] = 'Welcome to the FTP server';
    services.mail.enabled = true;
    const host = new HostPrompt(t.net, t.p0.id);

    expect(host.input('ftp 192.168.2.100 list')).toBe('welcome.txt');
    expect(host.input('ftp 192.168.2.100 get welcome.txt')).toBe('Welcome to the FTP server');
    expect(host.input('ftp 192.168.2.100 put upload.txt sent over tcp')).toBe('File stored');
    expect(services.ftp.files['upload.txt']).toBe('sent over tcp');
    expect(host.input('mail 192.168.2.100 send alice@example.test bob@example.test Lab Hello from NetLab')).toBe('Message accepted by SMTP server.');
    expect(host.input('mail 192.168.2.100 check bob@example.test')).toBe('1 alice@example.test Lab');
    expect(host.input('mail 192.168.2.100 check bob@example.test 1')).toContain('Hello from NetLab');
    expect(host.input('ntp 192.168.2.100')).toMatch(/^NTP time synchronized: \d+ ms \(simulation clock\)\.$/);

    const { Network, validateProject } = await import('../src');
    const copy = new Network(validateProject(structuredClone(t.net.serialize())));
    expect(copy.dev(server.id).doc.services?.ftp.files['upload.txt']).toBe('sent over tcp');
    expect(copy.dev(server.id).doc.services?.mail.messages).toHaveLength(1);
  });
});

describe('Telnet / SSH', () => {
  it('telnet needs a VTY password, then enable needs an enable password', () => {
    const { net, r1, p0 } = twoRouters();
    expect(pc(net, p0.id, 'telnet 192.168.2.1')).toContain('Password required, but none set');
    cli(net, r1.id, ['enable', 'conf t', 'line vty 0 4', 'password cisco', 'login', 'end']);
    const h = new HostPrompt(net, p0.id);
    expect(h.input('telnet 192.168.2.1')).toContain('Open');
    expect(h.prompt()).toBe('Password: ');
    h.input('cisco');
    expect(h.prompt()).toBe('R1>');
    expect(h.input('enable')).toContain('% No password set');
    expect(h.input('exit')).toContain('[Connection to 192.168.2.1 closed by foreign host]');
    expect(h.prompt()).toBe('C:\\>');
  });

  it('SSH requires keys, transport and a local user; telnet is refused when only SSH is allowed', () => {
    const { net, r1, p0 } = twoRouters();
    expect(pc(net, p0.id, 'ssh -l admin 192.168.2.1')).toContain('Connection refused');
    cli(net, r1.id, ['enable', 'conf t', 'ip domain-name lab.local', 'crypto key generate rsa', '1024', 'username admin secret Str0ng', 'line vty 0 4', 'login local', 'transport input ssh', 'end']);
    const h = new HostPrompt(net, p0.id);
    h.input('ssh -l admin 192.168.2.1');
    expect(h.prompt()).toBe('Password: ');
    h.input('Str0ng');
    expect(h.prompt()).toBe('R1>');
    expect(pc(net, p0.id, 'telnet 192.168.2.1')).toContain('Connection refused');
  });
});

describe('NAT / PAT', () => {
  it('PAT overload lets a private LAN reach a network without a return route', () => {
    const { net, r0, p0 } = twoRouters({ routes: false });
    cli(net, r0.id, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(false);
    cli(net, r0.id, ['enable', 'conf t', 'access-list 1 permit 192.168.1.0 0.0.0.255', 'ip nat inside source list 1 interface s0/0/0 overload', 'int g0/0', 'ip nat inside', 'int s0/0/0', 'ip nat outside', 'end']);
    // R1 knows 10.0.0.0/30 (connected) but not 192.168.1.0/24: only translation makes the reply possible.
    cli(net, net.doc.devices[1]!.id, ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.0.0.1', 'end']);
    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(true);
    expect(cli(net, r0.id, ['enable', 'show ip nat translations'])).toMatch(/icmp 10\.0\.0\.1:\d+\s+192\.168\.1\.10:\d+/);
  });

  it('static NAT publishes an inside server', () => {
    const { net, r0, p0, p1 } = twoRouters({ routes: false });
    cli(net, r0.id, ['enable', 'conf t', 'ip nat inside source static 192.168.1.10 10.0.0.5', 'int g0/0', 'ip nat inside', 'int s0/0/0', 'ip nat outside', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end']);
    cli(net, net.doc.devices[1]!.id, ['enable', 'conf t', 'ip route 10.0.0.4 255.255.255.252 10.0.0.1', 'end']);
    void p0;
    expect(pingOk(net, p1.id, '10.0.0.5')).toBe(true);
  });

  it('dynamic pool NAT translates traffic across a simulated outside network', () => {
    const { net, r0, p0, p1 } = twoRouters({ routes: false });
    cli(net, r0.id, [
      'enable', 'conf t',
      'access-list 1 permit 192.168.1.0 0.0.0.255',
      'ip nat pool PUB 10.0.0.5 10.0.0.6 netmask 255.255.255.252',
      'ip nat inside source list 1 pool PUB',
      'int g0/0', 'ip nat inside',
      'int s0/0/0', 'ip nat outside',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'end',
    ]);
    cli(net, net.doc.devices[1]!.id, ['enable', 'conf t', 'ip route 10.0.0.4 255.255.255.252 10.0.0.1', 'end']);

    expect(pingOk(net, p0.id, '192.168.2.10')).toBe(true);
    expect(cli(net, r0.id, ['enable', 'show ip nat translations'])).toMatch(/icmp 10\.0\.0\.5:\d+\s+192\.168\.1\.10:/);
  });
});

describe('IPv6', () => {
  it('OSPFv3 forms neighbors and routes between IPv6-only networks', () => {
    const net = newNet();
    const r0 = net.addDevice('1941', 0, 0);
    const r1 = net.addDevice('1941', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const b = net.addDevice('PC', 0, 0);
    net.addLink('crossover', { device: a.id, port: 'FastEthernet0' }, { device: r0.id, port: 'GigabitEthernet0/0' });
    net.addLink('crossover', { device: r0.id, port: 'GigabitEthernet0/1' }, { device: r1.id, port: 'GigabitEthernet0/1' });
    net.addLink('crossover', { device: b.id, port: 'FastEthernet0' }, { device: r1.id, port: 'GigabitEthernet0/0' });
    for (const [router, rid, lan, transit] of [
      [r0, '1.1.1.1', '2001:db8:10::1/64', '2001:db8:12::1/64'],
      [r1, '2.2.2.2', '2001:db8:20::1/64', '2001:db8:12::2/64'],
    ] as const) {
      cli(net, router.id, ['enable', 'conf t', 'ipv6 unicast-routing', 'ipv6 router ospf 10', `router-id ${rid}`, 'exit',
        'int g0/0', `ipv6 address ${lan}`, 'no shut', 'ipv6 ospf 10 area 0',
        'int g0/1', `ipv6 address ${transit}`, 'no shut', 'ipv6 ospf 10 area 0', 'end']);
    }
    net.setHostConfig(a.id, { ipv6: '2001:db8:10::10/64', ipv6Gateway: '2001:db8:10::1' });
    net.setHostConfig(b.id, { ipv6: '2001:db8:20::10/64', ipv6Gateway: '2001:db8:20::1' });
    expect(pc(net, a.id, 'ping 2001:db8:20::10')).toContain('Reply from 2001:DB8:20::10');
    expect(cli(net, r0.id, ['enable', 'show ipv6 ospf neighbor'])).toContain('2.2.2.2');
    expect(cli(net, r0.id, ['enable', 'show ipv6 route'])).toContain('O   2001:DB8:20::/64 [110/');
    const hello = net.log.find((event) => event.kind === 'deliver' && event.proto === 'OSPFv3' && event.frame.ip6?.ospf6?.type === 'HELLO');
    const lsa = net.log.find((event) => event.kind === 'deliver' && event.proto === 'OSPFv3' && event.frame.ip6?.ospf6?.type === 'LSA');
    expect(hello?.frame.ip6?.hop).toBe(1);
    expect(lsa?.frame.ip6?.ospf6?.prefixes).toEqual(expect.arrayContaining([expect.objectContaining({ len: 64 })]));
    const hellosBeforeTimer = net.log.filter((event) => event.kind === 'deliver' && event.proto === 'OSPFv3' && event.frame.ip6?.ospf6?.type === 'HELLO').length;
    net.advance(10_100);
    expect(net.log.filter((event) => event.kind === 'deliver' && event.proto === 'OSPFv3' && event.frame.ip6?.ospf6?.type === 'HELLO').length).toBeGreaterThan(hellosBeforeTimer);
  });

  it('autoconfigures a host with SLAAC and DHCPv6 and forwards IPv6 traffic', () => {
    const net = newNet();
    const r = net.addDevice('1941', 0, 0);
    const h = net.addDevice('PC', 0, 0);
    net.addLink('crossover', { device: h.id, port: 'FastEthernet0' }, { device: r.id, port: 'GigabitEthernet0/0' });
    cli(net, r.id, ['enable', 'conf t', 'int g0/0', 'ipv6 address 2001:db8:3::1/64', 'no shut', 'ipv6 unicast-routing', 'end']);
    net.setHostConfig(h.id, { ipv6: '', ipv6Mode: 'slaac' });
    expect(pc(net, h.id, 'ipv6config /renew')).toContain('2001:DB8:3:');
    expect(pc(net, h.id, 'ping 2001:db8:3::1')).toContain('Reply from 2001:DB8:3::1');

    cli(net, r.id, ['enable', 'conf t', 'ipv6 dhcp pool LAB', 'address prefix 2001:db8:3::/64', 'exit', 'int g0/0', 'ipv6 dhcp server LAB', 'ipv6 nd managed-config-flag', 'end']);
    net.setHostConfig(h.id, { ipv6: '', ipv6Mode: 'dhcpv6' });
    expect(pc(net, h.id, 'ipv6config /renew')).toContain('2001:DB8:3::2/64');
    expect(pc(net, h.id, 'ping 2001:db8:3::1')).toContain('Reply from 2001:DB8:3::1');
    expect(cli(net, r.id, ['enable', 'show ipv6 dhcp binding'])).toContain('2001:DB8:3::2');
  });

  it('static IPv6 addressing, NDP and routing between two LANs', () => {
    const net = newNet();
    const r = net.addDevice('1941', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const b = net.addDevice('PC', 0, 0);
    net.addLink('crossover', { device: a.id, port: 'FastEthernet0' }, { device: r.id, port: 'GigabitEthernet0/0' });
    net.addLink('crossover', { device: b.id, port: 'FastEthernet0' }, { device: r.id, port: 'GigabitEthernet0/1' });
    cli(net, r.id, ['enable', 'conf t', 'int g0/0', 'ipv6 address 2001:db8:1::1/64', 'no shut', 'int g0/1', 'ipv6 address 2001:db8:2::1/64', 'no shut', 'end']);
    net.setHostConfig(a.id, { ipv6: '2001:db8:1::10/64', ipv6Gateway: '2001:db8:1::1' });
    net.setHostConfig(b.id, { ipv6: '2001:db8:2::10/64', ipv6Gateway: '2001:db8:2::1' });
    expect(pc(net, a.id, 'ping 2001:db8:1::1')).toContain('Reply from 2001:DB8:1::1');
    expect(pc(net, a.id, 'ping 2001:db8:2::10')).toContain('Request timed out'); // routing not enabled yet
    cli(net, r.id, ['enable', 'conf t', 'ipv6 unicast-routing', 'end']);
    expect(pc(net, a.id, 'ping 2001:db8:2::10')).toContain('Reply from 2001:DB8:2::10');
    expect(cli(net, r.id, ['enable', 'show ipv6 interface brief'])).toMatch(/FE80::/);
    expect(cli(net, r.id, ['enable', 'show ipv6 route'])).toContain('C   2001:DB8:1::/64');
    expect(net.log.some((e) => e.proto === 'NDP')).toBe(true);
  });
});

describe('Wireless', () => {
  it('a laptop associates with an access point (SSID + WPA2 key, in range) and joins the LAN', () => {
    const net = newNet();
    const sw = net.addDevice('2960-24TT', 0, 0);
    const ap = net.addDevice('AccessPoint-PT', 100, 0);
    const pcd = net.addDevice('PC', 0, 0);
    const lap = net.addDevice('Laptop', 200, 100);
    net.addLink('straight', { device: ap.id, port: 'Port 0' }, { device: sw.id, port: 'FastEthernet0/1' });
    net.addLink('straight', { device: pcd.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/2' });
    net.dev(ap.id).doc.wireless = { ssid: 'NETLAB', security: 'wpa2', key: 'secret123' };
    setHost(net, pcd.id, '192.168.0.1', '255.255.255.0');
    net.setHostConfig(lap.id, { ip: '192.168.0.50', mask: '255.255.255.0', wifi: { ssid: 'NETLAB', key: 'wrongkey' } });
    net.converge();
    expect(net.wirelessLinks()).toEqual([]);
    net.setHostConfig(lap.id, { wifi: { ssid: 'NETLAB', key: 'secret123' } });
    net.converge();
    expect(net.wirelessLinks()).toEqual([{ client: lap.id, ap: ap.id }]);
    expect(pingOk(net, lap.id, '192.168.0.1')).toBe(true);
    net.moveDevices([{ id: lap.id, x: 2000, y: 2000 }]);
    net.refresh();
    expect(pingOk(net, lap.id, '192.168.0.1')).toBe(false);
  });
});

describe('persistence and grading of the new features', () => {
  it('RIP/OSPF/DHCP/NAT/IPv6 configuration round-trips through running-config', async () => {
    const { Network, validateProject } = await import('../src');
    const { net, r0 } = twoRouters();
    cli(net, r0.id, ['enable', 'conf t', 'router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'passive-interface g0/0', 'router ospf 10', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.3 area 0',
      'ip dhcp excluded-address 192.168.1.1 192.168.1.9', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 192.168.2.100',
      'access-list 1 permit 192.168.1.0 0.0.0.255', 'ip nat inside source list 1 interface s0/0/0 overload', 'ip nat pool PUB 10.0.0.5 10.0.0.6 netmask 255.255.255.252',
      'ipv6 unicast-routing', 'ipv6 dhcp pool V6', 'address prefix 2001:db8:1::/64', 'exit', 'ipv6 router ospf 20', 'router-id 2.2.2.2', 'exit',
      'int g0/0', 'ip nat inside', 'ipv6 address 2001:db8:1::1/64', 'ipv6 ospf 20 area 0', 'ipv6 dhcp server V6', 'int s0/0/0', 'ip nat outside',
      'ipv6 route ::/0 Serial0/0/0', 'end']);
    const before = net.runningConfig(net.dev(r0.id));
    const n2 = new Network(validateProject(structuredClone(net.serialize())));
    expect(n2.dev(r0.id).loadErrors).toEqual([]);
    expect(n2.runningConfig(n2.dev(r0.id))).toBe(before);
  });

  it('grades DHCP, DNS, service access and RIP criteria by behaviour', async () => {
    const { grade } = await import('../src');
    const { net, r0, r1 } = twoRouters({ routes: false });
    cli(net, r0.id, ['enable', 'conf t', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'router rip', 'version 2', 'network 10.0.0.0', 'network 192.168.1.0', 'end']);
    cli(net, r1.id, ['enable', 'conf t', 'router rip', 'version 2', 'network 10.0.0.0', 'network 192.168.2.0', 'line vty 0 4', 'password x', 'login', 'end']);
    const report = grade(structuredClone(net.serialize()), {
      maxScore: 4,
      criteria: [
        { id: 'dhcp', type: 'dhcp_client', device: 'PC0', points: 1 },
        { id: 'rip', type: 'route_exists', device: 'Router0', destination: '192.168.2.0/24', via: 'rip', points: 1 },
        { id: 'telnet', type: 'service_access', source: 'PC0', destination: '192.168.2.1', service: 'telnet', expected: 'allowed', points: 1 },
        { id: 'ssh', type: 'service_access', source: 'PC0', destination: '192.168.2.1', service: 'ssh', expected: 'denied', points: 1 },
      ],
    });
    expect(report.results.map((r) => [r.id, r.passed])).toEqual([['dhcp', true], ['rip', true], ['telnet', true], ['ssh', true]]);
    expect(report.score).toBe(4);
  });
});
