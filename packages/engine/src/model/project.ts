import { macFromNumber } from '../net/mac';
import { cableFits, CABLE_TYPES } from './cables';
import { devicePorts, isIosKind, MODELS, MODULES, modelSpec } from './catalog';
import type { CableType, DeviceDoc, HostConfig, LinkDoc, ProjectDoc, ServicesDoc } from './types';

export class ModelError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const LIMITS = {
  devices: 500,
  links: 2000,
  notes: 500,
  configBytes: 64 * 1024,
  nameLength: 64,
  noteLength: 2000,
};

export function createProject(name = 'Untitled'): ProjectDoc {
  return {
    format: 'netlab',
    schemaVersion: 1,
    name,
    devices: [],
    links: [],
    notes: [],
    zones: [],
    counters: { device: 0, link: 0, mac: 0, note: 0 },
  };
}

export function defaultServices(): ServicesDoc {
  return {
    dhcp: { enabled: false, pools: [{ name: 'serverPool', gateway: '', dns: '', start: '', mask: '255.255.255.0', max: 100 }] },
    dns: { enabled: false, records: [] },
    http: { enabled: true, https: true, pages: { '/index.html': '<html><body><h1>TPacket</h1><p>Welcome to this web server.</p></body></html>' } },
    tftp: { enabled: true, files: {} },
  };
}

export function validateServices(v: Json): ServicesDoc {
  const def = defaultServices();
  if (!isObj(v)) return def;
  const out = def;
  if (isObj(v.dhcp)) {
    out.dhcp.enabled = v.dhcp.enabled === true;
    if (Array.isArray(v.dhcp.pools)) {
      out.dhcp.pools = v.dhcp.pools.slice(0, 20).filter(isObj).map((x) => ({
        name: str(x.name ?? 'pool', 64, 'pool name'), gateway: str(x.gateway ?? '', 15, 'gateway'), dns: str(x.dns ?? '', 15, 'dns'),
        start: str(x.start ?? '', 15, 'start'), mask: str(x.mask ?? '', 15, 'mask'), max: Math.max(1, Math.min(4096, Math.floor(num(x.max ?? 100, 'max')))),
      }));
    }
  }
  if (isObj(v.dns)) {
    out.dns.enabled = v.dns.enabled === true;
    if (Array.isArray(v.dns.records)) out.dns.records = v.dns.records.slice(0, 500).filter(isObj).map((r) => ({ name: str(r.name, 253, 'dns name').toLowerCase(), ip: str(r.ip, 15, 'dns ip') }));
  }
  if (isObj(v.http)) {
    out.http.enabled = v.http.enabled !== false;
    out.http.https = v.http.https !== false;
    if (isObj(v.http.pages)) {
      out.http.pages = {};
      for (const [k, page] of Object.entries(v.http.pages).slice(0, 50)) out.http.pages[str(k, 100, 'page path')] = str(page, 64 * 1024, 'page');
    }
  }
  if (isObj(v.tftp)) {
    out.tftp.enabled = v.tftp.enabled !== false;
    if (isObj(v.tftp.files)) {
      out.tftp.files = {};
      for (const [k, f] of Object.entries(v.tftp.files).slice(0, 200)) out.tftp.files[str(k, 100, 'file name')] = str(f, 64 * 1024, 'file');
    }
  }
  return out;
}

export function defaultHostConfig(): HostConfig {
  return { ipMode: 'static', ip: '', mask: '', gateway: '', dns: '', portUp: true, ipv6Mode: 'static' };
}

/** Adds a device and returns it. The display name follows Packet Tracer's "<Prefix><n>" scheme. */
export function addDevice(p: ProjectDoc, model: string, x: number, y: number): DeviceDoc {
  const spec = modelSpec(model);
  if (p.devices.length >= LIMITS.devices) throw new ModelError('limit', `A project is limited to ${LIMITS.devices} devices`);
  let n = 0;
  const names = new Set(p.devices.map((d) => d.name));
  while (names.has(`${spec.namePrefix}${n}`)) n++;
  const modules = { ...(spec.defaultModules ?? {}) };
  const portCount = 64; // reserve a MAC block large enough for any module combination + SVIs
  const dev: DeviceDoc = {
    id: `d${++p.counters.device}`,
    model,
    name: `${spec.namePrefix}${n}`,
    x: Math.round(x),
    y: Math.round(y),
    powered: true,
    macBase: macFromNumber(p.counters.mac + 1),
    modules,
  };
  p.counters.mac += portCount;
  if (isIosKind(spec.kind)) {
    dev.running = '';
    dev.startup = null;
    if (spec.kind !== 'router') dev.vlanDb = [];
  } else if (spec.kind === 'host') {
    dev.host = defaultHostConfig();
    if (spec.ports.some((x) => x.media === 'wireless')) dev.host.wifi = { ssid: 'Default', key: '' };
    if (spec.role === 'server') dev.services = defaultServices();
  } else if (spec.kind === 'ap') {
    dev.wireless = { ssid: 'Default', security: 'open', key: '' };
  }
  p.devices.push(dev);
  return dev;
}

export function findDevice(p: ProjectDoc, id: string): DeviceDoc {
  const d = p.devices.find((x) => x.id === id);
  if (!d) throw new ModelError('not_found', `No device ${id}`);
  return d;
}

export function linkOnPort(p: ProjectDoc, device: string, port: string): LinkDoc | undefined {
  return p.links.find((l) => (l.a.device === device && l.a.port === port) || (l.b.device === device && l.b.port === port));
}

export function removeDevice(p: ProjectDoc, id: string): void {
  findDevice(p, id);
  p.links = p.links.filter((l) => l.a.device !== id && l.b.device !== id);
  p.devices = p.devices.filter((d) => d.id !== id);
}

export function addLink(p: ProjectDoc, cable: CableType, a: { device: string; port: string }, b: { device: string; port: string }): LinkDoc {
  if (p.links.length >= LIMITS.links) throw new ModelError('limit', `A project is limited to ${LIMITS.links} links`);
  if (a.device === b.device) throw new ModelError('same_device', 'A cable cannot connect a device to itself');
  const da = findDevice(p, a.device);
  const db = findDevice(p, b.device);
  const pa = devicePorts(da.model, da.modules).find((x) => x.name === a.port);
  const pb = devicePorts(db.model, db.modules).find((x) => x.name === b.port);
  if (!pa || !pb) throw new ModelError('no_port', 'Unknown port');
  if (linkOnPort(p, a.device, a.port) || linkOnPort(p, b.device, b.port)) throw new ModelError('port_busy', 'Port already in use');
  if (!cableFits(cable, pa.media, pb.media)) throw new ModelError('cable_mismatch', `A ${cable} cable does not fit ${pa.name} and ${pb.name}`);
  const link: LinkDoc = { id: `l${++p.counters.link}`, cable, a: { ...a }, b: { ...b } };
  p.links.push(link);
  return link;
}

export function removeLink(p: ProjectDoc, id: string): void {
  p.links = p.links.filter((l) => l.id !== id);
}

/** Installs/removes a module. Like real hardware, the device must be powered off. */
export function setModule(p: ProjectDoc, deviceId: string, bay: string, module: string | null): void {
  const d = findDevice(p, deviceId);
  const spec = modelSpec(d.model);
  const b = spec.bays.find((x) => x.id === bay);
  if (!b) throw new ModelError('no_bay', `No bay ${bay}`);
  if (d.powered) throw new ModelError('powered', 'Turn the device off before changing modules');
  if (module === null) {
    const current = d.modules[bay];
    if (current) {
      const removed = new Set(MODULES[current]!.ports(b.prefix).map((x) => x.name));
      p.links = p.links.filter((l) => !((l.a.device === d.id && removed.has(l.a.port)) || (l.b.device === d.id && removed.has(l.b.port))));
    }
    delete d.modules[bay];
    return;
  }
  if (!b.accepts.includes(module)) throw new ModelError('incompatible_module', `${module} does not fit ${b.label}`);
  if (d.modules[bay]) throw new ModelError('bay_busy', 'Remove the installed module first');
  d.modules[bay] = module;
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted documents (uploads, API submissions). Structural only: IOS text is
// validated later, line by line, by the CLI parser when the network is built.
// ---------------------------------------------------------------------------------------------

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: Json, max: number, field: string): string => {
  if (typeof v !== 'string' || v.length > max) throw new ModelError('invalid', `Invalid ${field}`);
  return v;
};
const num = (v: Json, field: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7) throw new ModelError('invalid', `Invalid ${field}`);
  return v;
};
const id = (v: Json, field: string): string => {
  const s = str(v, 32, field);
  if (!/^[a-z]\d+$/.test(s)) throw new ModelError('invalid', `Invalid ${field}`);
  return s;
};

export function validateProject(input: Json): ProjectDoc {
  if (!isObj(input) || input.format !== 'netlab' || input.schemaVersion !== 1) throw new ModelError('invalid', 'Not a TPacket project (schemaVersion 1)');
  const devices = input.devices;
  const links = input.links;
  if (!Array.isArray(devices) || devices.length > LIMITS.devices) throw new ModelError('invalid', 'Invalid devices');
  if (!Array.isArray(links) || links.length > LIMITS.links) throw new ModelError('invalid', 'Invalid links');
  const p = createProject(str(input.name ?? 'Untitled', 200, 'name'));
  const counters = isObj(input.counters) ? input.counters : {};
  const seen = new Set<string>();
  for (const raw of devices) {
    if (!isObj(raw)) throw new ModelError('invalid', 'Invalid device');
    const model = str(raw.model, 32, 'model');
    if (!MODELS[model]) throw new ModelError('invalid', `Unknown model ${model}`);
    const spec = MODELS[model]!;
    const d: DeviceDoc = {
      id: id(raw.id, 'device id'),
      model,
      name: str(raw.name, LIMITS.nameLength, 'device name'),
      x: num(raw.x, 'x'),
      y: num(raw.y, 'y'),
      powered: raw.powered !== false,
      macBase: str(raw.macBase, 12, 'macBase'),
      modules: {},
    };
    if (!/^[0-9a-f]{12}$/.test(d.macBase)) throw new ModelError('invalid', 'Invalid macBase');
    if (seen.has(d.id)) throw new ModelError('invalid', 'Duplicate device id');
    seen.add(d.id);
    if (isObj(raw.modules)) {
      for (const [bay, mod] of Object.entries(raw.modules)) {
        const b = spec.bays.find((x) => x.id === bay);
        if (!b || typeof mod !== 'string' || !b.accepts.includes(mod)) throw new ModelError('invalid', `Invalid module in ${bay}`);
        d.modules[bay] = mod;
      }
    }
    if (isIosKind(spec.kind)) {
      d.running = str(raw.running ?? '', LIMITS.configBytes, 'running-config');
      d.startup = raw.startup === null || raw.startup === undefined ? null : str(raw.startup, LIMITS.configBytes, 'startup-config');
      if (raw.rsaModulus !== undefined) d.rsaModulus = num(raw.rsaModulus, 'rsaModulus');
      if (spec.kind !== 'router') {
        d.vlanDb = [];
        if (Array.isArray(raw.vlanDb)) {
          if (raw.vlanDb.length > 4094) throw new ModelError('invalid', 'Invalid vlanDb');
          for (const v of raw.vlanDb) {
            if (!isObj(v)) throw new ModelError('invalid', 'Invalid vlan');
            const vid = num(v.id, 'vlan id');
            if (!Number.isInteger(vid) || vid < 2 || vid > 4094) throw new ModelError('invalid', 'Invalid vlan id');
            d.vlanDb.push({ id: vid, name: str(v.name, 32, 'vlan name') });
          }
        }
      }
    } else if (spec.kind === 'host') {
      const h = isObj(raw.host) ? raw.host : {};
      if (h.ipv6Mode !== undefined && !['static', 'slaac', 'dhcpv6'].includes(String(h.ipv6Mode))) {
        throw new ModelError('invalid', 'Invalid IPv6 configuration mode');
      }
      d.host = {
        ipMode: h.ipMode === 'dhcp' ? 'dhcp' : 'static',
        ip: str(h.ip ?? '', 15, 'ip'),
        mask: str(h.mask ?? '', 15, 'mask'),
        gateway: str(h.gateway ?? '', 15, 'gateway'),
        dns: str(h.dns ?? '', 15, 'dns'),
        portUp: h.portUp !== false,
        ...(h.ipv6 ? { ipv6: str(h.ipv6, 50, 'ipv6') } : {}),
        ...(h.ipv6Gateway ? { ipv6Gateway: str(h.ipv6Gateway, 45, 'ipv6 gateway') } : {}),
        ipv6Mode: h.ipv6Mode === 'slaac' || h.ipv6Mode === 'dhcpv6' ? h.ipv6Mode : 'static',
        ...(isObj(h.wifi) ? { wifi: { ssid: str(h.wifi.ssid ?? '', 32, 'ssid'), key: str(h.wifi.key ?? '', 63, 'wifi key') } } : {}),
      };
      if (spec.role === 'server') d.services = validateServices(raw.services);
    } else if (spec.kind === 'ap') {
      const w = isObj(raw.wireless) ? raw.wireless : {};
      d.wireless = { ssid: str(w.ssid ?? 'Default', 32, 'ssid'), security: w.security === 'wpa2' ? 'wpa2' : 'open', key: str(w.key ?? '', 63, 'wifi key') };
    }
    p.devices.push(d);
  }
  const used = new Set<string>();
  for (const raw of links) {
    if (!isObj(raw) || !isObj(raw.a) || !isObj(raw.b)) throw new ModelError('invalid', 'Invalid link');
    const cable = raw.cable as CableType;
    if (!CABLE_TYPES.includes(cable)) throw new ModelError('invalid', 'Invalid cable');
    const ends = [raw.a, raw.b].map((e) => ({ device: id(e.device, 'link device'), port: str(e.port, 40, 'link port') }));
    for (const e of ends) {
      const d = p.devices.find((x) => x.id === e.device);
      if (!d) throw new ModelError('invalid', 'Link to unknown device');
      const port = devicePorts(d.model, d.modules).find((x) => x.name === e.port);
      if (!port) throw new ModelError('invalid', `Unknown port ${e.port}`);
      const key = `${e.device}|${e.port}`;
      if (used.has(key)) throw new ModelError('invalid', 'Port used twice');
      used.add(key);
    }
    const [ea, eb] = ends as [{ device: string; port: string }, { device: string; port: string }];
    if (ea.device === eb.device) throw new ModelError('invalid', 'Self link');
    const pa = devicePorts(findDevice(p, ea.device).model, findDevice(p, ea.device).modules).find((x) => x.name === ea.port)!;
    const pb = devicePorts(findDevice(p, eb.device).model, findDevice(p, eb.device).modules).find((x) => x.name === eb.port)!;
    if (!cableFits(cable, pa.media, pb.media)) throw new ModelError('invalid', 'Cable does not fit ports');
    p.links.push({ id: id(raw.id, 'link id'), cable, a: ea, b: eb });
  }
  if (Array.isArray(input.notes)) {
    for (const n of input.notes.slice(0, LIMITS.notes)) {
      if (!isObj(n)) continue;
      p.notes.push({ id: id(n.id, 'note id'), x: num(n.x, 'x'), y: num(n.y, 'y'), text: str(n.text, LIMITS.noteLength, 'note'), color: str(n.color ?? '#facc15', 16, 'color') });
    }
  }
  if (Array.isArray(input.zones)) {
    for (const z of input.zones.slice(0, LIMITS.notes)) {
      if (!isObj(z)) continue;
      p.zones.push({ id: id(z.id, 'zone id'), x: num(z.x, 'x'), y: num(z.y, 'y'), w: num(z.w, 'w'), h: num(z.h, 'h'), label: str(z.label, LIMITS.nameLength, 'zone label'), color: str(z.color ?? '#6366f1', 16, 'color') });
    }
  }
  const maxIdNum = (xs: { id: string }[]) => xs.reduce((m, x) => Math.max(m, Number(x.id.slice(1))), 0);
  p.counters = {
    device: Math.max(Number(counters.device) || 0, maxIdNum(p.devices)),
    link: Math.max(Number(counters.link) || 0, maxIdNum(p.links)),
    mac: Math.max(Number(counters.mac) || 0, ...p.devices.map((d) => parseInt(d.macBase.slice(6), 16) + 64)),
    note: Math.max(Number(counters.note) || 0, maxIdNum([...p.notes, ...p.zones])),
  };
  return p;
}
