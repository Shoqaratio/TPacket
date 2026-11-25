/**
 * Persisted project document (`.netlab` format, see docs/FORMATS.md).
 *
 * Network-device configuration is persisted as IOS configuration TEXT (running + startup),
 * not as a JSON structure: the CLI interpreter is the single authority on configuration
 * semantics, so loading a project replays the text through the same parser a student uses.
 * This makes untrusted documents safe to load (every line is validated by the parser) and gives
 * Cisco-text import/export for free.
 */

export type DeviceKind = 'router' | 'switch' | 'l3switch' | 'host' | 'hub' | 'ap';
export type HostRole = 'pc' | 'laptop' | 'server' | 'printer' | 'smartphone' | 'tablet';
export type Media = 'copper' | 'fiber' | 'serial' | 'console' | 'rs232' | 'wireless';
export type CableType = 'straight' | 'crossover' | 'console' | 'fiber' | 'serial-dce' | 'serial-dte';

export interface PortSpec {
  name: string;
  media: Media;
  /** Nominal speed in Mbit/s (serial: 1.544). */
  speed: number;
  /** Gigabit copper ports auto-negotiate MDI/MDI-X. */
  autoMdix?: boolean;
}

export interface HostConfig {
  ipMode: 'static' | 'dhcp';
  ip: string;
  mask: string;
  gateway: string;
  dns: string;
  /** Administrative state of the NIC ("Port Status" in the Config tab). */
  portUp: boolean;
  /** Static IPv6 address with prefix ("2001:db8:1::10/64"), empty when unused. */
  ipv6?: string;
  ipv6Gateway?: string;
  /** Wireless client settings (laptops, smartphones, tablets). */
  wifi?: { ssid: string; key: string };
}

export interface DhcpPoolDoc {
  name: string;
  gateway: string;
  dns: string;
  start: string;
  mask: string;
  max: number;
}

/** Services of the Server device (Services tab). */
export interface ServicesDoc {
  dhcp: { enabled: boolean; pools: DhcpPoolDoc[] };
  dns: { enabled: boolean; records: { name: string; ip: string }[] };
  http: { enabled: boolean; https: boolean; pages: Record<string, string> };
  tftp: { enabled: boolean; files: Record<string, string> };
}

export interface WirelessDoc {
  ssid: string;
  security: 'open' | 'wpa2';
  key: string;
}

export interface DeviceDoc {
  id: string;
  model: string;
  /** Display name shown on the canvas (independent of the IOS hostname, as in Packet Tracer). */
  name: string;
  x: number;
  y: number;
  powered: boolean;
  /** First MAC of the device; ports use consecutive addresses. */
  macBase: string;
  /** bay id -> module id */
  modules: Record<string, string>;
  /** IOS devices: running configuration text. */
  running?: string;
  /** IOS devices: NVRAM startup-config, null when erased / never saved. */
  startup?: string | null;
  /** IOS switches: vlan.dat contents (survives `erase startup-config`, as on real switches). */
  vlanDb?: { id: number; name: string }[];
  /** IOS devices: RSA key modulus, if `crypto key generate rsa` was run (keys are not in running-config). */
  rsaModulus?: number;
  /** End devices. */
  host?: HostConfig;
  /** Server services. */
  services?: ServicesDoc;
  /** Access point radio settings. */
  wireless?: WirelessDoc;
}

export interface LinkEnd {
  device: string;
  port: string;
}

export interface LinkDoc {
  id: string;
  cable: CableType;
  /** For serial cables, `a` is the DCE end for 'serial-dce' and the DTE end for 'serial-dte'. */
  a: LinkEnd;
  b: LinkEnd;
}

export interface NoteDoc {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface ZoneDoc {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  color: string;
}

export interface ProjectDoc {
  format: 'netlab';
  schemaVersion: 1;
  name: string;
  devices: DeviceDoc[];
  links: LinkDoc[];
  notes: NoteDoc[];
  zones: ZoneDoc[];
  /** Monotonic counters keep generated ids and MACs deterministic. */
  counters: { device: number; link: number; mac: number; note: number };
}
