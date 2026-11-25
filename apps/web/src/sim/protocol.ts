import type { CableType, DeviceKind, HostConfig, LinkLight, Media, NoteDoc, ProjectDoc, ServicesDoc, SimEvent, WirelessDoc, ZoneDoc } from '@netlab/engine';

export interface PortView {
  name: string;
  media: Media;
  linked: boolean;
  light: LinkLight;
  status: string;
  ip?: string;
}

export interface DeviceView {
  id: string;
  model: string;
  kind: DeviceKind;
  role?: string;
  name: string;
  hostname: string;
  x: number;
  y: number;
  powered: boolean;
  ips: string[];
  ports: PortView[];
  modules: Record<string, string>;
  host?: HostConfig;
  services?: ServicesDoc;
  wireless?: WirelessDoc;
  ipConflict?: boolean;
  modified?: boolean;
  loadErrors: string[];
}

export interface LinkView {
  id: string;
  cable: CableType;
  a: { device: string; port: string; light: LinkLight };
  b: { device: string; port: string; light: LinkLight };
}

export interface ProjectView {
  name: string;
  now: number;
  devices: DeviceView[];
  links: LinkView[];
  wireless: { client: string; ap: string }[];
  notes: NoteDoc[];
  zones: ZoneDoc[];
  canUndo: boolean;
  canRedo: boolean;
  pending: number;
}

export interface PduView {
  id: number;
  src: string;
  dst: string;
  protocol: 'icmp' | 'tcp' | 'udp';
  srcPort?: number;
  dstPort?: number;
  status: 'in-progress' | 'successful' | 'failed';
}

export type CliKind = 'ios' | 'host';
export interface CliResult {
  output: string;
  prompt: string;
  secret: boolean;
}

export type OpName =
  | 'addDevice'
  | 'removeItems'
  | 'addLink'
  | 'autoLink'
  | 'removeLink'
  | 'moveDevices'
  | 'renameDevice'
  | 'setPower'
  | 'setModule'
  | 'setHostConfig'
  | 'duplicate'
  | 'pasteSelection'
  | 'addNote'
  | 'addZone'
  | 'updateAnnotation'
  | 'removeAnnotation'
  | 'rename'
  | 'importConfig'
  | 'setServices'
  | 'setWireless'
  | 'dhcpRenew'
  | 'ipv6Renew';

export type Request =
  | { method: 'open'; project: string; doc: ProjectDoc }
  | { method: 'close'; project: string }
  | { method: 'op'; project: string; op: OpName; args: unknown[] }
  | { method: 'undo' | 'redo'; project: string }
  | { method: 'serialize'; project: string }
  | { method: 'runningConfig'; project: string; device: string }
  | { method: 'browse'; project: string; device: string; url: string }
  | { method: 'diagnose'; project: string; device: string; dst: string; locale: 'fr' | 'en' }
  | { method: 'grade'; project: string; rubric: unknown }
  | { method: 'cli'; project: string; session: string; device: string; kind: CliKind; action: 'open' | 'input' | 'help' | 'complete' | 'close'; text?: string }
  | { method: 'tick'; project: string; ms: number }
  | { method: 'simStep'; project: string }
  | { method: 'simReset'; project: string }
  | { method: 'simPdu'; project: string; src: string; dst: string; protocol?: 'icmp' | 'tcp' | 'udp'; dstPort?: number };

export type WorkerMessage =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string; code?: string }
  | { type: 'view'; project: string; view: ProjectView }
  | { type: 'events'; project: string; events: SimEvent[] }
  | { type: 'console'; project: string; device: string; text: string }
  | { type: 'pdus'; project: string; pdus: PduView[] }
  | { type: 'dirty'; project: string };
