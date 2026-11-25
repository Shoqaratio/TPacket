import type { DeviceKind, DeviceRole, PortSpec, WirelessDoc } from './types';

export interface ModuleSpec {
  id: string;
  description: string;
  /** Builds the module's ports from the bay's naming prefix. */
  ports(prefix: string): PortSpec[];
}

export interface BaySpec {
  id: string;
  label: string;
  /** Interface-number prefix for ports of a module in this bay, e.g. "0/0" -> Serial0/0/0. */
  prefix: string;
  accepts: string[];
}

export interface ModelSpec {
  id: string;
  label: string;
  kind: DeviceKind;
  role?: DeviceRole;
  /** Name prefix for new devices ("Router" -> Router0, Router1, ...). */
  namePrefix: string;
  ports: PortSpec[];
  bays: BaySpec[];
  defaultModules?: Record<string, string>;
  defaultWireless?: WirelessDoc;
  defaultConfig?: string;
  /** IOS image string shown by `show version`. */
  ios?: { version: string; image: string; platform: string; memory: string; flash: string };
  /** IOS 15 shows local (/32 "L") routes in the routing table. */
  localRoutes?: boolean;
}

const range = (n: number, f: (i: number) => PortSpec): PortSpec[] => Array.from({ length: n }, (_, i) => f(i));
const fe = (name: string): PortSpec => ({ name, media: 'copper', speed: 100 });
const ge = (name: string): PortSpec => ({ name, media: 'copper', speed: 1000, autoMdix: true });
const con: PortSpec = { name: 'Console', media: 'console', speed: 0 };
const wl = (name: string): PortSpec => ({ name, media: 'wireless', speed: 54 });

export const MODULES: Record<string, ModuleSpec> = {
  'HWIC-2T': {
    id: 'HWIC-2T',
    description: '2-port serial WAN interface card',
    ports: (p) => range(2, (i) => ({ name: `Serial${p}/${i}`, media: 'serial', speed: 1.544 })),
  },
  'WIC-2T': {
    id: 'WIC-2T',
    description: '2-port serial WAN interface card',
    ports: (p) => range(2, (i) => ({ name: `Serial${p}/${i}`, media: 'serial', speed: 1.544 })),
  },
  'NM-1CFE': {
    id: 'NM-1CFE',
    description: '1-port FastEthernet copper module',
    ports: (p) => [fe(`FastEthernet${p}`)],
  },
  'NM-1FFE': {
    id: 'NM-1FFE',
    description: '1-port FastEthernet fiber module',
    ports: (p) => [{ name: `FastEthernet${p}`, media: 'fiber', speed: 100 }],
  },
  'NM-1S': {
    id: 'NM-1S',
    description: '1-port serial module',
    ports: (p) => [{ name: `Serial${p}`, media: 'serial', speed: 1.544 }],
  },
};

function bays(kind: 'HWIC' | 'EHWIC', count: number): BaySpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${kind}${i}`,
    label: `${kind} ${i}`,
    prefix: `0/${i}`,
    accepts: ['HWIC-2T'],
  }));
}

const IOS_124 = { version: '12.4(15)T1', image: 'C1841-ADVIPSERVICESK9-M', platform: 'Cisco 1841 (revision 5.0)', memory: '114688K/16384K', flash: '63488K' };

export const MODELS: Record<string, ModelSpec> = {
  '1841': {
    id: '1841', label: 'Cisco 1841', kind: 'router', namePrefix: 'Router',
    ports: [fe('FastEthernet0/0'), fe('FastEthernet0/1'), con],
    bays: bays('HWIC', 2),
    ios: IOS_124,
  },
  '1941': {
    id: '1941', label: 'Cisco 1941', kind: 'router', namePrefix: 'Router',
    ports: [ge('GigabitEthernet0/0'), ge('GigabitEthernet0/1'), con],
    bays: bays('EHWIC', 2),
    ios: { version: '15.1(4)M4', image: 'C1900-UNIVERSALK9-M', platform: 'Cisco CISCO1941/K9 (revision 1.0)', memory: '491520K/32768K', flash: '255744K' },
    localRoutes: true,
  },
  '2621XM': {
    id: '2621XM', label: 'Cisco 2621XM', kind: 'router', namePrefix: 'Router',
    ports: [fe('FastEthernet0/0'), fe('FastEthernet0/1'), con],
    bays: [{ id: 'WIC0', label: 'WIC 0', prefix: '0', accepts: ['WIC-2T'] }],
    ios: { version: '12.2(4)T', image: 'C2600-I-M', platform: 'Cisco 2621XM (MPC860P)', memory: '60416K/5120K', flash: '32768K' },
  },
  '2811': {
    id: '2811', label: 'Cisco 2811', kind: 'router', namePrefix: 'Router',
    ports: [fe('FastEthernet0/0'), fe('FastEthernet0/1'), con],
    bays: bays('HWIC', 4),
    ios: { ...IOS_124, image: 'C2800NM-ADVIPSERVICESK9-M', platform: 'Cisco 2811 (revision 2.0)', memory: '249856K/12288K' },
  },
  '2911': {
    id: '2911', label: 'Cisco 2911', kind: 'router', namePrefix: 'Router',
    ports: [ge('GigabitEthernet0/0'), ge('GigabitEthernet0/1'), ge('GigabitEthernet0/2'), con],
    bays: bays('EHWIC', 4),
    ios: { version: '15.1(4)M4', image: 'C2900-UNIVERSALK9-M', platform: 'Cisco CISCO2911/K9 (revision 1.0)', memory: '491520K/32768K', flash: '255744K' },
    localRoutes: true,
  },
  'Router-PT': {
    id: 'Router-PT', label: 'Generic router', kind: 'router', namePrefix: 'Router',
    ports: [fe('FastEthernet0/0'), fe('FastEthernet1/0'), con],
    bays: [2, 3, 4, 5].map((n) => ({ id: `NM${n}`, label: `Slot ${n}`, prefix: `${n}/0`, accepts: ['NM-1CFE', 'NM-1FFE', 'NM-1S'] })),
    defaultModules: { NM2: 'NM-1S', NM3: 'NM-1S' },
    ios: { version: '12.2(28)', image: 'PT1000-I-M', platform: 'PT 1001 (PTSC2005)', memory: '60416K/5120K', flash: '63488K' },
  },
  'WirelessRouter-PT': {
    id: 'WirelessRouter-PT', label: 'Wireless Router-PT', kind: 'router', role: 'wireless-router', namePrefix: 'Wireless Router',
    ports: [ge('GigabitEthernet0/0'), ge('GigabitEthernet0/1'), wl('Wireless0'), con],
    bays: [],
    defaultWireless: { ssid: 'Home', security: 'wpa2', key: 'netlabwifi' },
    defaultConfig: 'interface Wireless0\n no shutdown',
    ios: { version: '15.1(4)M4', image: 'TPACKET-HOME-ROUTER', platform: 'TPacket Wireless Router', memory: '131072K/16384K', flash: '65536K' },
  },
  'Firewall-PT': {
    id: 'Firewall-PT', label: 'Firewall-PT (IOS ACL)', kind: 'router', role: 'firewall', namePrefix: 'Firewall',
    ports: [ge('GigabitEthernet0/0'), ge('GigabitEthernet0/1'), con],
    bays: [],
    ios: { version: '1.0', image: 'TPACKET-FIREWALL', platform: 'TPacket Firewall Router', memory: '131072K/16384K', flash: '65536K' },
  },
  '2960-24TT': {
    id: '2960-24TT', label: 'Catalyst 2960-24TT', kind: 'switch', namePrefix: 'Switch',
    ports: [...range(24, (i) => fe(`FastEthernet0/${i + 1}`)), ge('GigabitEthernet0/1'), ge('GigabitEthernet0/2'), con],
    bays: [],
    ios: { version: '12.2(25)FX', image: 'C2960-LANBASE-M', platform: 'cisco WS-C2960-24TT (RC32300)', memory: '60416K/4088K', flash: '64016K' },
  },
  '3560-24PS': {
    id: '3560-24PS', label: 'Catalyst 3560-24PS (multilayer)', kind: 'l3switch', namePrefix: 'Multilayer Switch',
    ports: [...range(24, (i) => fe(`FastEthernet0/${i + 1}`)), ge('GigabitEthernet0/1'), ge('GigabitEthernet0/2'), con],
    bays: [],
    ios: { version: '12.2(37)SE1', image: 'C3560-ADVIPSERVICESK9-M', platform: 'cisco WS-C3560-24PS (PowerPC405)', memory: '122880K/8184K', flash: '15360K' },
  },
  'Switch-PT': {
    id: 'Switch-PT', label: 'Generic switch', kind: 'switch', namePrefix: 'Switch',
    ports: [...range(8, (i) => fe(`FastEthernet0/${i + 1}`)), con],
    bays: [1, 2, 3, 4].map((n) => ({ id: `NM${n}`, label: `Slot ${n}`, prefix: `${n}/1`, accepts: ['NM-1CFE', 'NM-1FFE'] })),
    ios: { version: '12.1(22)EA4', image: 'C2950-I6Q4L2-M', platform: 'PT 3000 (PTSC2005)', memory: '60416K/5120K', flash: '64016K' },
  },
  'Hub-PT': {
    id: 'Hub-PT', label: 'Hub', kind: 'hub', namePrefix: 'Hub',
    ports: range(6, (i) => fe(`Port ${i}`)), bays: [],
  },
  'Modem-PT': {
    id: 'Modem-PT', label: 'Modem-PT (Ethernet bridge)', kind: 'hub', role: 'modem', namePrefix: 'Modem',
    ports: [fe('Ethernet0'), fe('Ethernet1')], bays: [],
  },
  'Cloud-PT': {
    id: 'Cloud-PT', label: 'Cloud-PT (WAN bridge)', kind: 'hub', role: 'cloud', namePrefix: 'Cloud',
    ports: range(6, (i) => fe(`Port ${i}`)), bays: [],
  },
  PC: {
    id: 'PC', label: 'PC', kind: 'host', role: 'pc', namePrefix: 'PC',
    ports: [fe('FastEthernet0'), { name: 'RS 232', media: 'rs232', speed: 0 }], bays: [],
  },
  Laptop: {
    id: 'Laptop', label: 'Laptop', kind: 'host', role: 'laptop', namePrefix: 'Laptop',
    ports: [fe('FastEthernet0'), wl('Wireless0'), { name: 'RS 232', media: 'rs232', speed: 0 }], bays: [],
  },
  Smartphone: {
    id: 'Smartphone', label: 'Smartphone', kind: 'host', role: 'smartphone', namePrefix: 'Smartphone',
    ports: [wl('Wireless0')], bays: [],
  },
  Tablet: {
    id: 'Tablet', label: 'Tablet', kind: 'host', role: 'tablet', namePrefix: 'Tablet',
    ports: [wl('Wireless0')], bays: [],
  },
  'IP-Phone-PT': {
    id: 'IP-Phone-PT', label: 'IP Phone-PT', kind: 'host', role: 'ipphone', namePrefix: 'IP Phone',
    ports: [fe('FastEthernet0')], bays: [],
  },
  'IoT-PT': {
    id: 'IoT-PT', label: 'IoT Device-PT', kind: 'host', role: 'iot', namePrefix: 'IoT',
    ports: [fe('FastEthernet0'), wl('Wireless0')], bays: [],
  },
  'AccessPoint-PT': {
    id: 'AccessPoint-PT', label: 'Access point', kind: 'ap', namePrefix: 'Access Point',
    ports: [fe('Port 0'), wl('Port 1')], bays: [],
  },
  Server: {
    id: 'Server', label: 'Server', kind: 'host', role: 'server', namePrefix: 'Server',
    ports: [fe('FastEthernet0')], bays: [],
  },
  Printer: {
    id: 'Printer', label: 'Network printer', kind: 'host', role: 'printer', namePrefix: 'Printer',
    ports: [fe('FastEthernet0')], bays: [],
  },
};

export function modelSpec(id: string): ModelSpec {
  const m = MODELS[id];
  if (!m) throw new Error(`Unknown device model ${id}`);
  return m;
}

/** All physical ports of a device: fixed ports followed by ports of installed modules (in bay order). */
export function devicePorts(model: string, modules: Record<string, string>): PortSpec[] {
  const spec = modelSpec(model);
  const out = spec.ports.filter((p) => p.media !== 'console' && p.media !== 'rs232');
  for (const bay of spec.bays) {
    const mod = modules[bay.id];
    if (mod && MODULES[mod]) out.push(...MODULES[mod]!.ports(bay.prefix));
  }
  // Console / RS-232 last so data ports keep stable MAC offsets.
  out.push(...spec.ports.filter((p) => p.media === 'console' || p.media === 'rs232'));
  return out;
}

export function isIosKind(kind: DeviceKind): boolean {
  return kind === 'router' || kind === 'switch' || kind === 'l3switch';
}
