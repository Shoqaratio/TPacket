import type { Network, RtDevice } from '../sim/network';
import { IosSession } from './session';

/**
 * Replays configuration text (running-config, startup-config, pasted or imported Cisco config)
 * through the CLI parser in global configuration mode. Returns error messages for lines the
 * parser rejected, so nothing is ever dropped silently.
 */
export function loadIosConfig(net: Network, d: RtDevice, text: string): string[] {
  const s = new IosSession(net, d.doc.id, { replay: true, dev: d });
  return replay(s, text);
}

export function replay(s: IosSession, text: string): string[] {
  const errors: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const t = line.trim();
    if (!t || t.startsWith('!')) continue;
    if (t === 'end') break;
    if (/^(Building configuration|Current configuration)/.test(t)) continue;
    // Multi-line banner: gather lines until the delimiter closes.
    const b = /^banner\s+motd\s+(\S)/.exec(t);
    if (b) {
      const delim = b[1]!.startsWith('^') && t.includes('^C') ? '^C' : b[1]!;
      const startIdx = t.indexOf(delim) + delim.length;
      let body = t.slice(startIdx);
      while (!body.includes(delim) && i + 1 < lines.length) body += '\n' + lines[++i];
      line = `banner motd ${delim}${body}`;
    }
    const out = s.input(line);
    if (s.failed) errors.push(`% Line ${i + 1}: "${t}" rejected${out ? `: ${out.trim().split('\n').pop()}` : ''}`);
    // Replay never stays in a password / confirmation prompt.
    if (s.prompt().endsWith(': ') || s.prompt().endsWith('? ')) s.input('');
    if (s.mode === 'priv' || s.mode === 'user') s.mode = 'config';
  }
  s.mode = 'config';
  return errors;
}

/**
 * Merges configuration text into a running device, like `copy tftp running-config`:
 * a merge does not bring interfaces up by itself (IOS semantics). Returns rejected lines.
 */
export function importConfig(net: Network, devId: string, text: string): string[] {
  const s = new IosSession(net, devId);
  s.awaitingReturn = false;
  s.mode = 'config';
  const errors = replay(s, text);
  net.refresh();
  return errors;
}
