import { createProject, HostPrompt, IosSession, Network, parseIp } from '../src';

export function newNet() {
  return new Network(createProject('test'));
}

/** Runs CLI lines on a device (after "Press RETURN") and returns all output. */
export function cli(net: Network, devId: string, lines: string[]): string {
  const s = new IosSession(net, devId);
  s.input('');
  return lines.map((l) => s.input(l)).join('\n');
}

export function pc(net: Network, devId: string, cmd: string): string {
  return new HostPrompt(net, devId).input(cmd);
}

export function setHost(net: Network, id: string, ip: string, mask: string, gateway = '') {
  net.setHostConfig(id, { ip, mask, gateway });
}

export function pingOk(net: Network, from: string, to: string, tries = 6): boolean {
  for (let i = 0; i < tries; i++) if (net.echo(from, parseIp(to)!).kind === 'reply') return true;
  return false;
}

/** PC0 - Switch0 - PC1 on 192.168.1.0/24. */
export function lan() {
  const net = newNet();
  const sw = net.addDevice('2960-24TT', 300, 100);
  const a = net.addDevice('PC', 100, 300);
  const b = net.addDevice('PC', 500, 300);
  net.addLink('straight', { device: a.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/1' });
  net.addLink('straight', { device: b.id, port: 'FastEthernet0' }, { device: sw.id, port: 'FastEthernet0/2' });
  setHost(net, a.id, '192.168.1.10', '255.255.255.0', '192.168.1.1');
  setHost(net, b.id, '192.168.1.11', '255.255.255.0', '192.168.1.1');
  net.converge();
  return { net, sw, a, b };
}

/**
 * PC0 - SW0 - R0 ==serial== R1 - SW1 - PC1
 * 192.168.1.0/24       10.0.0.0/30       192.168.2.0/24
 */
export function twoRouters(opts: { routes?: boolean } = {}) {
  const net = newNet();
  const r0 = net.addDevice('1941', 0, 0);
  const r1 = net.addDevice('1941', 0, 0);
  for (const r of [r0, r1]) {
    net.setPower(r.id, false);
    net.setModule(r.id, 'EHWIC0', 'HWIC-2T');
    net.setPower(r.id, true);
  }
  const s0 = net.addDevice('2960-24TT', 0, 0);
  const s1 = net.addDevice('2960-24TT', 0, 0);
  const p0 = net.addDevice('PC', 0, 0);
  const p1 = net.addDevice('PC', 0, 0);
  net.addLink('serial-dce', { device: r0.id, port: 'Serial0/0/0' }, { device: r1.id, port: 'Serial0/0/0' });
  net.addLink('straight', { device: r0.id, port: 'GigabitEthernet0/0' }, { device: s0.id, port: 'GigabitEthernet0/1' });
  net.addLink('straight', { device: r1.id, port: 'GigabitEthernet0/0' }, { device: s1.id, port: 'GigabitEthernet0/1' });
  net.addLink('straight', { device: p0.id, port: 'FastEthernet0' }, { device: s0.id, port: 'FastEthernet0/1' });
  net.addLink('straight', { device: p1.id, port: 'FastEthernet0' }, { device: s1.id, port: 'FastEthernet0/1' });
  cli(net, r0.id, [
    'enable', 'conf t', 'hostname R0',
    'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut',
    'int s0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'clock rate 64000', 'no shut', 'end',
  ]);
  cli(net, r1.id, [
    'enable', 'conf t', 'hostname R1',
    'int g0/0', 'ip address 192.168.2.1 255.255.255.0', 'no shut',
    'int s0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shut', 'end',
  ]);
  if (opts.routes !== false) {
    cli(net, r0.id, ['enable', 'conf t', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end']);
    cli(net, r1.id, ['enable', 'conf t', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1', 'end']);
  }
  setHost(net, p0.id, '192.168.1.10', '255.255.255.0', '192.168.1.1');
  setHost(net, p1.id, '192.168.2.10', '255.255.255.0', '192.168.2.1');
  net.converge();
  return { net, r0, r1, s0, s1, p0, p1 };
}
