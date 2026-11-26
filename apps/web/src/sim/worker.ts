/// <reference lib="webworker" />
/**
 * Hosts one deterministic Network per open project, off the main thread.
 * The UI only ever sees view models; all simulation state lives here.
 */
import {
  autoCable,
  devicePorts,
  HostPrompt,
  diagnose,
  grade,
  browse,
  importConfig,
  IosSession,
  ipToString,
  isIosKind,
  maskToPrefix,
  ModelError,
  Network,
  parseIp,
  type CableType,
  type ProjectDoc,
  type SimEvent,
  validateProject,
} from '@netlab/engine';
import type { CliResult, DeviceView, OpName, PduView, ProjectView, Request, WorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface Open {
  net: Network;
  undo: string[];
  redo: string[];
  sessions: Map<string, IosSession | HostPrompt>;
  lastEventSeq: number;
  pdus: PduView[];
  pduSeq: number;
  lastDhcpRevision?: number;
}

const projects = new Map<string, Open>();
const post = (m: WorkerMessage) => self.postMessage(m);
const UNDO_LIMIT = 50;

function attach(project: string, net: Network): void {
  net.onConsole = (device, text) => post({ type: 'console', project, device, text });
}

function view(project: string, o: Open): ProjectView {
  const net = o.net;
  const devices: DeviceView[] = [];
  for (const d of net.devices.values()) {
    const ports = devicePorts(d.doc.model, d.doc.modules).map((p) => {
      const linked = !!net.linkOf(d.doc.id, p.name);
      const st = d.ios?.interfaces.has(p.name) ? net.ifStatus(d, p.name) : net.portStatus(d.doc.id, p.name);
      const ipCfg = d.ios?.interfaces.get(p.name)?.ip;
      return {
        name: p.name,
        media: p.media,
        linked,
        light: linked ? net.light(d.doc.id, p.name) : 'off',
        status: st.adminDown ? 'admin-down' : st.proto ? 'up' : st.l1 ? 'up-down' : 'down',
        ...(ipCfg ? { ip: `${ipToString(ipCfg.address)}/${maskToPrefix(ipCfg.mask)}` } : {}),
      } as const;
    });
    const ips = net.l3Ifs(d).map((i) => `${ipToString(i.ip)}/${maskToPrefix(i.mask)}`);
    devices.push({
      id: d.doc.id,
      model: d.doc.model,
      kind: d.kind,
      ...(d.spec.role ? { role: d.spec.role } : {}),
      name: d.doc.name,
      hostname: d.hostname(),
      x: d.doc.x,
      y: d.doc.y,
      powered: d.doc.powered,
      ips,
      ports,
      modules: { ...d.doc.modules },
      ...(d.host ? { host: structuredClone(d.host) } : {}),
      ...(d.doc.services ? { services: structuredClone(d.doc.services) } : {}),
      ...(d.doc.wireless ? { wireless: { ...d.doc.wireless } } : {}),
      ...(d.ipConflict ? { ipConflict: true } : {}),
      ...(d.ios ? { modified: (d.doc.startup ?? null) !== net.runningConfig(d) } : {}),
      loadErrors: d.loadErrors,
    });
  }
  const light = (dev: string, port: string) => net.light(dev, port);
  return {
    name: net.doc.name,
    now: net.now,
    devices,
    links: net.doc.links.map((l) => ({ id: l.id, cable: l.cable, a: { ...l.a, light: light(l.a.device, l.a.port) }, b: { ...l.b, light: light(l.b.device, l.b.port) } })),
    wireless: net.wirelessLinks(),
    notes: net.doc.notes.map((n) => ({ ...n })),
    zones: net.doc.zones.map((z) => ({ ...z })),
    canUndo: o.undo.length > 0,
    canRedo: o.redo.length > 0,
    pending: net.pendingEvents(),
  };
}

function publish(project: string, o: Open, dirty = false): void {
  post({ type: 'view', project, view: view(project, o) });
  const fresh: SimEvent[] = o.net.log.filter((e) => e.seq > o.lastEventSeq);
  if (fresh.length) {
    o.lastEventSeq = fresh[fresh.length - 1]!.seq;
    post({ type: 'events', project, events: fresh.slice(-500) });
  }
  post({ type: 'pdus', project, pdus: o.pdus.map((p) => ({ ...p })) });
  if (dirty || o.net.dhcpRevision !== (o.lastDhcpRevision ?? 0)) post({ type: 'dirty', project });
  o.lastDhcpRevision = o.net.dhcpRevision;
}

function snapshot(o: Open): string {
  return JSON.stringify(o.net.serialize());
}

function restore(project: string, o: Open, json: string): void {
  const now = o.net.now;
  o.net = new Network(validateProject(JSON.parse(json)));
  o.net.now = now;
  attach(project, o.net);
  o.sessions.clear();
}

function runOp(o: Open, op: OpName, args: unknown[]): unknown {
  const net = o.net;
  const a = args as [never, never, never, never, never];
  switch (op) {
    case 'addDevice':
      return net.addDevice(a[0], a[1], a[2]).id;
    case 'removeItems': {
      const [ids] = args as [string[]];
      for (const id of ids) {
        if (net.devices.has(id)) net.removeDevice(id);
        else if (net.doc.links.some((l) => l.id === id)) net.removeLink(id);
        else net.removeAnnotation(id);
      }
      return null;
    }
    case 'addLink': {
      const [cable, x, y] = args as [CableType, { device: string; port: string }, { device: string; port: string }];
      return net.addLink(cable, x, y).id;
    }
    case 'autoLink': {
      // "Automatically choose connection type": first free compatible ports, cable chosen like a technician would.
      const [ad, bd] = args as [string, string];
      const A = net.dev(ad);
      const B = net.dev(bd);
      for (const pa of devicePorts(A.doc.model, A.doc.modules)) {
        if (net.linkOf(ad, pa.name) || pa.media === 'console' || pa.media === 'rs232') continue;
        for (const pb of devicePorts(B.doc.model, B.doc.modules)) {
          if (net.linkOf(bd, pb.name) || pb.media !== pa.media) continue;
          const cable = autoCable(A.kind, pa, B.kind, pb);
          if (cable) return net.addLink(cable, { device: ad, port: pa.name }, { device: bd, port: pb.name }).id;
        }
      }
      throw new ModelError('no_free_port', 'No free compatible ports');
    }
    case 'removeLink':
      return net.removeLink(a[0]);
    case 'moveDevices': {
      const [moves] = args as [{ id: string; x: number; y: number }[]];
      const dev = moves.filter((m) => net.devices.has(m.id));
      net.moveDevices(dev);
      for (const m of moves.filter((x) => !net.devices.has(x.id))) net.updateAnnotation(m.id, { x: Math.round(m.x), y: Math.round(m.y) });
      return null;
    }
    case 'renameDevice':
      return net.renameDevice(a[0], a[1]);
    case 'setPower':
      return net.setPower(a[0], a[1]);
    case 'setModule':
      return net.setModule(a[0], a[1], a[2]);
    case 'setHostConfig':
      return net.setHostConfig(a[0], a[1]);
    case 'duplicate':
      return net.duplicate(a[0], a[1], a[2]);
    case 'pasteSelection':
      return net.pasteSelection(a[0], a[1], a[2]);
    case 'addNote':
      return net.addNote(a[0], a[1], a[2]);
    case 'addZone':
      return net.addZone(a[0], a[1], a[2], a[3], a[4]);
    case 'updateAnnotation':
      return net.updateAnnotation(a[0], a[1]);
    case 'removeAnnotation':
      return net.removeAnnotation(a[0]);
    case 'rename':
      net.doc.name = String(a[0]).slice(0, 200);
      return null;
    case 'setServices':
      return net.setServices(a[0], a[1]);
    case 'setWireless':
      return net.setWireless(a[0], a[1]);
    case 'dhcpRenew':
      return net.dhcpRenew(a[0]);
    case 'ipv6Renew':
      return net.ipv6Renew(a[0]);
    case 'importConfig': {
      const [dev, text] = args as [string, string];
      const d = net.dev(dev);
      if (!isIosKind(d.kind)) throw new ModelError('not_ios', 'Not an IOS device');
      return importConfig(net, dev, text);
    }
  }
}

const NON_UNDOABLE = new Set<OpName>(['rename', 'dhcpRenew', 'ipv6Renew']);

function handle(r: Request): unknown {
  if (r.method === 'open') {
    const doc = validateProject(r.doc);
    const net = new Network(doc);
    attach(r.project, net);
    const o: Open = { net, undo: [], redo: [], sessions: new Map(), lastEventSeq: 0, pdus: [], pduSeq: 0 };
    projects.set(r.project, o);
    publish(r.project, o);
    return null;
  }
  const o = projects.get(r.project);
  if (!o) throw new Error('project not open');
  switch (r.method) {
    case 'close':
      projects.delete(r.project);
      return null;
    case 'op': {
      const before = NON_UNDOABLE.has(r.op) ? null : snapshot(o);
      const value = runOp(o, r.op, r.args);
      if (before) {
        o.undo.push(before);
        if (o.undo.length > UNDO_LIMIT) o.undo.shift();
        o.redo = [];
      }
      publish(r.project, o, true);
      return value;
    }
    case 'undo':
    case 'redo': {
      const from = r.method === 'undo' ? o.undo : o.redo;
      const to = r.method === 'undo' ? o.redo : o.undo;
      const target = from.pop();
      if (!target) return null;
      to.push(snapshot(o));
      restore(r.project, o, target);
      publish(r.project, o, true);
      return null;
    }
    case 'diagnose':
      return diagnose(o.net, r.device, r.dst, r.locale);
    case 'grade':
      return grade(structuredClone(o.net.serialize()), r.rubric);
    case 'browse': {
      const res = browse(o.net, r.device, r.url);
      publish(r.project, o, true);
      return res;
    }
    case 'serialize':
      return structuredClone(o.net.serialize());
    case 'runningConfig': {
      const d = o.net.dev(r.device);
      return d.ios ? o.net.runningConfig(d) : '';
    }
    case 'cli': {
      let s = o.sessions.get(r.session);
      if (r.action === 'close') {
        o.sessions.delete(r.session);
        return null;
      }
      if (!s) {
        s = r.kind === 'ios' ? new IosSession(o.net, r.device) : new HostPrompt(o.net, r.device);
        o.sessions.set(r.session, s);
        if (r.action !== 'input') {
          const res: CliResult = { output: s.greeting(), prompt: s.prompt(), secret: false };
          return res;
        }
      }
      if (r.action === 'open') {
        // The console line keeps its state (mode, pending prompt) when the terminal is reopened.
        const res: CliResult = { output: '', prompt: s.prompt(), secret: s.isSecretInput() };
        return res;
      }
      if (r.action === 'help') return s instanceof IosSession ? s.help(r.text ?? '') : '';
      if (r.action === 'complete') return s instanceof IosSession ? s.complete(r.text ?? '') : null;
      const output = s.input(r.text ?? '');
      publish(r.project, o, true);
      const res: CliResult = { output, prompt: s.prompt(), secret: s.isSecretInput() };
      return res;
    }
    case 'tick':
      o.net.advance(Math.min(Math.max(r.ms, 0), 60_000));
      publish(r.project, o);
      return o.net.now;
    case 'simStep': {
      const progressed = o.net.step();
      if (!progressed) for (const p of o.pdus) if (p.status === 'in-progress') p.status = 'failed';
      publish(r.project, o);
      return progressed;
    }
    case 'simReset':
      o.net.resetSimulation();
      o.pdus = [];
      o.lastEventSeq = 0;
      publish(r.project, o);
      return null;
    case 'simPdu': {
      const src = o.net.dev(r.src);
      const dstDev = o.net.dev(r.dst);
      const dstIp = o.net.l3Ifs(dstDev)[0]?.ip ?? parseIp(r.dst);
      if (dstIp === undefined || dstIp === null) throw new ModelError('no_ip', 'Destination has no IP address');
      const protocol = r.protocol ?? 'icmp';
      const dstPort = r.dstPort ?? (protocol === 'tcp' ? 80 : 53);
      if (protocol !== 'icmp' && (!Number.isInteger(dstPort) || dstPort < 1 || dstPort > 65535)) {
        throw new ModelError('invalid_port', 'Destination port must be between 1 and 65535');
      }
      const pdu: PduView = {
        id: ++o.pduSeq,
        src: src.doc.name,
        dst: dstDev.doc.name,
        protocol,
        ...(protocol !== 'icmp' ? { dstPort } : {}),
        status: 'in-progress',
      };
      o.pdus.push(pdu);
      const result = o.net.injectPdu(r.src, dstIp, protocol, dstPort, (res) => {
        pdu.status = res.kind === 'reply' || res.kind === 'data' || res.kind === 'synack' ? 'successful' : 'failed';
      });
      if (!result.sent) pdu.status = 'failed';
      if (result.sourcePort !== undefined) pdu.srcPort = result.sourcePort;
      publish(r.project, o);
      return pdu.id;
    }
  }
}

self.onmessage = (ev: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = ev.data;
  try {
    const value = handle(req);
    post({ type: 'reply', id, ok: true, value });
  } catch (e) {
    const err = e as Error & { code?: string };
    post({ type: 'reply', id, ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
};

export type { ProjectDoc };
