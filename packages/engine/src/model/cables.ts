import type { CableType, DeviceKind, Media, PortSpec } from './types';

/** Which port media each cable can physically plug into. */
export function cableFits(cable: CableType, a: Media, b: Media): boolean {
  switch (cable) {
    case 'straight':
    case 'crossover':
      return a === 'copper' && b === 'copper';
    case 'fiber':
      return a === 'fiber' && b === 'fiber';
    case 'console':
      return (a === 'console' && b === 'rs232') || (a === 'rs232' && b === 'console');
    case 'serial-dce':
    case 'serial-dte':
      return a === 'serial' && b === 'serial';
  }
}

/** Hosts and routers are MDI; switches and hubs are MDI-X. */
export function isMdi(kind: DeviceKind): boolean {
  return kind === 'host' || kind === 'router' || kind === 'ap';
}

/**
 * Whether a plugged copper cable yields a working physical layer.
 * Straight-through links unlike devices, crossover links like devices, unless one end auto-negotiates MDI-X.
 */
export function copperPinoutOk(cable: CableType, aKind: DeviceKind, aPort: PortSpec, bKind: DeviceKind, bPort: PortSpec): boolean {
  if (cable !== 'straight' && cable !== 'crossover') return true;
  if (aPort.autoMdix && bPort.autoMdix) return true;
  const unlike = isMdi(aKind) !== isMdi(bKind);
  return cable === 'straight' ? unlike : !unlike;
}

/** "Automatically choose connection type": the cable a technician would pick. */
export function autoCable(aKind: DeviceKind, aPort: PortSpec, bKind: DeviceKind, bPort: PortSpec): CableType | null {
  const a = aPort.media;
  const b = bPort.media;
  if ((a === 'console' && b === 'rs232') || (a === 'rs232' && b === 'console')) return 'console';
  if (a === 'serial' && b === 'serial') return 'serial-dce';
  if (a === 'fiber' && b === 'fiber') return 'fiber';
  if (a === 'copper' && b === 'copper') return isMdi(aKind) !== isMdi(bKind) ? 'straight' : 'crossover';
  return null;
}

export const CABLE_TYPES: CableType[] = ['straight', 'crossover', 'console', 'fiber', 'serial-dce', 'serial-dte'];
