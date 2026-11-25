import { describe, expect, it } from 'vitest';
import { createProject, Network } from '../src';
import { cli, newNet, pingOk, setHost } from './helpers';

describe('phase 2 equipment', () => {
  it('uses the modem and cloud as transparent WAN bridges between terminal devices', () => {
    const net = newNet();
    const modem = net.addDevice('Modem-PT', 0, 0);
    const cloud = net.addDevice('Cloud-PT', 0, 0);
    const phone = net.addDevice('IP-Phone-PT', 0, 0);
    const iot = net.addDevice('IoT-PT', 0, 0);

    net.addLink('straight', { device: phone.id, port: 'FastEthernet0' }, { device: modem.id, port: 'Ethernet0' });
    net.addLink('crossover', { device: modem.id, port: 'Ethernet1' }, { device: cloud.id, port: 'Port 0' });
    net.addLink('straight', { device: cloud.id, port: 'Port 1' }, { device: iot.id, port: 'FastEthernet0' });
    setHost(net, phone.id, '10.20.0.2', '255.255.255.0');
    setHost(net, iot.id, '10.20.0.3', '255.255.255.0');

    expect(pingOk(net, phone.id, '10.20.0.3')).toBe(true);
  });

  it('provides a configurable wireless router and basic IP phone/IoT host behavior', () => {
    const net = newNet();
    const router = net.addDevice('WirelessRouter-PT', 0, 0);
    const laptop = net.addDevice('Laptop', 5, 5);
    cli(net, router.id, ['enable', 'conf t', 'int g0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shut', 'end']);
    net.setHostConfig(laptop.id, {
      ip: '192.168.10.10', mask: '255.255.255.0', gateway: '192.168.10.1',
      wifi: { ssid: 'Home', key: 'netlabwifi' },
    });

    expect(net.association(net.dev(laptop.id))?.doc.id).toBe(router.id);
    expect(pingOk(net, laptop.id, '192.168.10.1')).toBe(true);
    expect(net.dev(router.id).doc.wireless).toEqual({ ssid: 'Home', security: 'wpa2', key: 'netlabwifi' });
  });

  it('uses the existing IOS ACL engine as a routed firewall', () => {
    const net = newNet();
    const firewall = net.addDevice('Firewall-PT', 0, 0);
    const a = net.addDevice('PC', 0, 0);
    const b = net.addDevice('PC', 0, 0);
    net.addLink('crossover', { device: a.id, port: 'FastEthernet0' }, { device: firewall.id, port: 'GigabitEthernet0/0' });
    net.addLink('crossover', { device: b.id, port: 'FastEthernet0' }, { device: firewall.id, port: 'GigabitEthernet0/1' });
    cli(net, firewall.id, [
      'enable', 'conf t',
      'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut',
      'int g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shut',
      'ip access-list extended BLOCK-PING', 'deny icmp any any', 'permit ip any any',
      'int g0/1', 'ip access-group BLOCK-PING out', 'end',
    ]);
    setHost(net, a.id, '192.168.1.10', '255.255.255.0', '192.168.1.1');
    setHost(net, b.id, '192.168.2.10', '255.255.255.0', '192.168.2.1');

    expect(pingOk(net, a.id, '192.168.2.10')).toBe(false);
    expect(net.log.some((e) => e.reason?.code === 'acl_out')).toBe(true);
  });
});

describe('inter-project selection import', () => {
  it('pastes validated devices, active IOS config, internal links and annotations with fresh ids', () => {
    const source = newNet();
    const firewall = source.addDevice('Firewall-PT', 20, 30);
    const phone = source.addDevice('IP-Phone-PT', 180, 30);
    source.addLink('crossover', { device: firewall.id, port: 'GigabitEthernet0/0' }, { device: phone.id, port: 'FastEthernet0' });
    cli(source, firewall.id, ['enable', 'conf t', 'hostname Edge', 'int g0/0', 'ip address 192.168.4.1 255.255.255.0', 'no shut', 'end']);
    setHost(source, phone.id, '192.168.4.10', '255.255.255.0', '192.168.4.1');
    const noteId = source.addNote(100, 160, 'WAN boundary');
    source.updateAnnotation(noteId, { color: '#22aa55' });
    const fragment = structuredClone(source.serialize());

    const target = new Network(createProject('target'));
    target.addDevice('PC', 0, 0);
    const newIds = target.pasteSelection(fragment, 50, 60);
    const copiedFirewall = target.dev(newIds[0]!);
    const copiedPhone = target.dev(newIds[1]!);

    expect(newIds[0]).not.toBe(firewall.id);
    expect(copiedFirewall.doc.x).toBe(70);
    expect(copiedFirewall.doc.running).toContain('hostname Edge');
    expect(copiedPhone.doc.host?.ip).toBe('192.168.4.10');
    expect(target.doc.links).toHaveLength(1);
    expect(target.doc.notes[0]).toMatchObject({ text: 'WAN boundary', color: '#22aa55', x: 150, y: 220 });
    expect(target.dev(copiedFirewall.doc.id).loadErrors).toEqual([]);
  });
});
