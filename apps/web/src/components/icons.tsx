/** Original TPacket device pictograms (not derived from Cisco artwork). */
import type { DeviceKind } from '@netlab/engine';

interface P {
  kind: DeviceKind;
  role?: string | undefined;
  size?: number;
  off?: boolean;
}

export function DeviceIcon({ kind, role, size = 48, off }: P) {
  const stroke = off ? '#64748b' : '#e2e8f5';
  const fill = off ? '#334155' : kind === 'router' ? '#2563eb' : kind === 'switch' ? '#0891b2' : kind === 'l3switch' ? '#7c3aed' : kind === 'hub' ? '#0d9488' : '#475569';
  const common = { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true } as const;
  if (kind === 'router')
    return (
      <svg {...common}>
        <ellipse cx="24" cy="30" rx="20" ry="9" fill={fill} opacity="0.7" />
        <rect x="4" y="18" width="40" height="12" fill={fill} />
        <ellipse cx="24" cy="18" rx="20" ry="9" fill={fill} stroke={stroke} strokeWidth="1.2" />
        <g stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round">
          <path d="M14 15l6 3M14 15l1.5 3.5M34 21l-6-3M34 21l-1.5-3.5M27 12l-3 3M27 12l-3.5-.5M21 24l3-3M21 24l3.5.5" />
        </g>
      </svg>
    );
  if (kind === 'switch' || kind === 'l3switch')
    return (
      <svg {...common}>
        <path d="M4 20 L12 12 H44 L36 20 Z" fill={fill} stroke={stroke} strokeWidth="1" opacity="0.85" />
        <rect x="4" y="20" width="32" height="14" fill={fill} stroke={stroke} strokeWidth="1" />
        <path d="M36 20 L44 12 V26 L36 34 Z" fill={fill} opacity="0.6" stroke={stroke} strokeWidth="1" />
        <g stroke={stroke} strokeWidth="1.8" fill="none" strokeLinecap="round">
          <path d="M9 24h10l-2.5-2M27 30H17l2.5 2" />
        </g>
        {kind === 'l3switch' && <path d="M24 4l4 5h-8z" fill="#facc15" />}
      </svg>
    );
  if (kind === 'hub')
    return (
      <svg {...common}>
        <rect x="4" y="18" width="40" height="14" rx="2" fill={fill} stroke={stroke} strokeWidth="1" />
        {[10, 18, 26, 34].map((x) => (
          <circle key={x} cx={x} cy="25" r="2.4" fill={stroke} />
        ))}
      </svg>
    );
  if (kind === 'ap')
    return (
      <svg {...common}>
        <rect x="8" y="26" width="32" height="12" rx="3" fill={fill === '#475569' ? '#0f766e' : fill} stroke={stroke} strokeWidth="1.2" />
        <g fill="none" stroke={off ? stroke : '#38bdf8'} strokeWidth="2" strokeLinecap="round">
          <path d="M17 19a10 10 0 0 1 14 0M13 14a16 16 0 0 1 22 0" />
        </g>
        <circle cx="24" cy="23" r="2" fill={stroke} />
      </svg>
    );
  if (role === 'smartphone' || role === 'tablet') {
    const w = role === 'tablet' ? 30 : 18;
    return (
      <svg {...common}>
        <rect x={24 - w / 2} y="6" width={w} height="36" rx="3" fill={fill} stroke={stroke} strokeWidth="1.2" />
        <rect x={24 - w / 2 + 2} y="10" width={w - 4} height="26" fill="#0ea5e9" opacity="0.45" />
        <circle cx="24" cy="39" r="1.3" fill={stroke} />
      </svg>
    );
  }
  if (role === 'server')
    return (
      <svg {...common}>
        <rect x="14" y="4" width="20" height="40" rx="2" fill={fill} stroke={stroke} strokeWidth="1.2" />
        {[10, 18, 26].map((y) => (
          <rect key={y} x="17" y={y} width="14" height="5" rx="1" fill="none" stroke={stroke} strokeWidth="1" />
        ))}
        <circle cx="24" cy="38" r="1.8" fill="#22c55e" />
      </svg>
    );
  if (role === 'laptop')
    return (
      <svg {...common}>
        <rect x="9" y="10" width="30" height="20" rx="1.5" fill={fill} stroke={stroke} strokeWidth="1.2" />
        <rect x="12" y="13" width="24" height="14" fill="#0ea5e9" opacity="0.5" />
        <path d="M4 34h40l-4 5H8z" fill={fill} stroke={stroke} strokeWidth="1.2" />
      </svg>
    );
  if (role === 'printer')
    return (
      <svg {...common}>
        <rect x="14" y="6" width="20" height="10" fill="#e2e8f0" stroke={stroke} strokeWidth="1" />
        <rect x="6" y="16" width="36" height="16" rx="2" fill={fill} stroke={stroke} strokeWidth="1.2" />
        <rect x="14" y="28" width="20" height="12" fill="#e2e8f0" stroke={stroke} strokeWidth="1" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="6" y="6" width="36" height="26" rx="2" fill={fill} stroke={stroke} strokeWidth="1.2" />
      <rect x="9" y="9" width="30" height="20" fill="#0ea5e9" opacity="0.45" />
      <path d="M20 32h8l2 7h-12z" fill={fill} stroke={stroke} strokeWidth="1" />
      <rect x="13" y="39" width="22" height="3" rx="1" fill={fill} stroke={stroke} strokeWidth="1" />
    </svg>
  );
}

export const CABLE_STYLE: Record<string, { color: string; dash?: string; label: string }> = {
  straight: { color: '#94a3b8', label: 'straight' },
  crossover: { color: '#94a3b8', dash: '6 4', label: 'crossover' },
  console: { color: '#38bdf8', dash: '2 3', label: 'console' },
  fiber: { color: '#f97316', label: 'fiber' },
  'serial-dce': { color: '#ef4444', label: 'serial' },
  'serial-dte': { color: '#ef4444', label: 'serial' },
};

export const LIGHT_COLOR: Record<string, string> = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444', off: '#6b7280' };
