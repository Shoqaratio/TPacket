import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { sim } from '../sim/client';
import type { CliKind } from '../sim/protocol';
import { editLine } from './lineEditor';

interface Props {
  project: string;
  device: string;
  kind: CliKind;
  /** Stable id of the CLI session (one per open terminal). */
  session: string;
  autoFocus?: boolean;
}

const PAGE = 23;

/**
 * Line discipline implemented client-side (echo, backspace, history, TAB, `?`), command
 * execution in the simulation worker. Pasted text is processed character by character, so
 * pasting a whole configuration works like on a real console.
 */
export function Terminal({ project, device, kind, session, autoFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({
      fontFamily: 'JetBrains Mono, ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#05080f', foreground: '#d7e0f0', cursor: '#3b82f6', selectionBackground: '#1e3a8a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* element not laid out yet */
    }
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(el);
    if (autoFocus) term.focus();

    let line = '';
    let cursor = 0;
    let prompt = '';
    let secret = false;
    const history: string[] = [];
    let hIdx = -1;
    let keyWaiter: ((k: string) => void) | null = null;
    // System messages raised while a command runs are printed after its output, as IOS does.
    let busy = false;
    const queued: string[] = [];
    let disposed = false;
    const write = (s: string) => !disposed && term.write(s.replace(/\r?\n/g, '\r\n'));

    const nextKey = () => new Promise<string>((r) => (keyWaiter = r));

    async function paginate(out: string) {
      const lines = out.split('\n');
      if (lines.length <= PAGE) return write(out);
      write(lines.slice(0, PAGE).join('\n'));
      let i = PAGE;
      while (i < lines.length) {
        write('\n --More-- ');
        const k = await nextKey();
        write('\r          \r');
        if (k === ' ') {
          write(lines.slice(i, i + PAGE).join('\n'));
          i += PAGE;
        } else if (k === '\r' || k === '\n') {
          write(lines[i]!);
          i++;
        } else break;
      }
    }

    const redraw = () => {
      write(`\r\x1b[2K${prompt}${secret ? '' : line}`);
      if (!secret && cursor < line.length) write(`\x1b[${line.length - cursor}D`);
    };

    const replaceLine = (next: string) => {
      line = next;
      cursor = line.length;
      redraw();
    };

    const applyEdit = (edit: Parameters<typeof editLine>[1]) => {
      const next = editLine({ text: line, cursor }, edit);
      line = next.text;
      cursor = next.cursor;
      if (!secret) redraw();
    };

    async function submit() {
      const text = line;
      line = '';
      cursor = 0;
      hIdx = -1;
      if (text.trim() && !secret) history.unshift(text);
      if (history.length > 50) history.pop();
      write('\r\x1b[2K');
      write('\n');
      busy = true;
      const r = await sim.cli(project, session, device, kind, 'input', text).finally(() => (busy = false));
      if (r.output) {
        await paginate(r.output);
        write('\n');
      }
      if (queued.length) write(queued.splice(0).join('\n') + '\n');
      prompt = r.prompt;
      secret = r.secret;
      write(prompt);
    }

    async function handleChar(ch: string) {
      if (keyWaiter) {
        const w = keyWaiter;
        keyWaiter = null;
        return w(ch);
      }
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') return submit();
      if (code === 127 || code === 8) {
        applyEdit({ type: 'delete', direction: 'backward' });
        return;
      }
      if (ch === '\t') {
        if (kind !== 'ios' || secret) return;
        const c = await sim.cliComplete(project, session, device, kind, line);
        if (c) replaceLine(c);
        return;
      }
      if (ch === '?' && kind === 'ios' && !secret) {
        write('?\n');
        const h = await sim.cliHelp(project, session, device, kind, line);
        if (h) write(h + '\n');
        redraw();
        return;
      }
      if (code === 1 && !secret) return applyEdit({ type: 'move', direction: 'start' });
      if (code === 5 && !secret) return applyEdit({ type: 'move', direction: 'end' });
      if (code === 23 && !secret) return applyEdit({ type: 'delete', direction: 'word' });
      if (code === 3 || code === 26) {
        // Ctrl+C / Ctrl+Z: abandon the line; in configuration modes return to privileged EXEC.
        if (kind === 'ios' && prompt.includes('(')) {
          line = 'end';
          cursor = line.length;
          write('^Z');
          return submit();
        }
        line = '';
        cursor = 0;
        write('^C\n' + prompt);
        return;
      }
      if (code < 32) return;
      if (cursor === line.length) {
        line += ch;
        cursor += ch.length;
        if (!secret) write(ch);
      } else applyEdit({ type: 'insert', text: ch });
    }

    let chain = Promise.resolve();
    const onData = term.onData((data) => {
      const moves: Record<string, 'left' | 'right' | 'start' | 'end'> = {
        '\x1b[A': 'left',
        '\x1b[B': 'right',
        '\x1b[D': 'left',
        '\x1b[C': 'right',
        '\x1b[H': 'start',
        '\x1b[F': 'end',
        '\x1b[1~': 'start',
        '\x1b[4~': 'end',
      };
      if (data === '\x1b[A' || data === '\x1b[B') {
        chain = chain.then(() => {
          if (secret || keyWaiter) return;
          if (data === '\x1b[A' && hIdx + 1 < history.length) hIdx++;
          else if (data === '\x1b[B' && hIdx >= 0) hIdx--;
          replaceLine(hIdx >= 0 ? history[hIdx]! : '');
        });
        return;
      }
      if (data in moves || data === '\x1b[3~') {
        chain = chain.then(() => {
          if (secret || keyWaiter) return;
          if (data === '\x1b[3~') applyEdit({ type: 'delete', direction: 'forward' });
          else applyEdit({ type: 'move', direction: moves[data]! });
        });
        return;
      }
      if (data.startsWith('\x1b')) return;
      for (const ch of data) chain = chain.then(() => handleChar(ch));
    });

    const unsub = sim.onConsole(project, device, (text) => {
      if (kind !== 'ios') return;
      if (busy) queued.push(text);
      else {
        write(`\r\x1b[2K\n${text}\n`);
        redraw();
      }
    });

    sim
      .cli(project, session, device, kind, 'open')
      .then((r) => {
        if (r.output) write(r.output.replace(/^\n/, '') + '\n');
        prompt = r.prompt;
        write(prompt);
      })
      .catch((e: Error) => write(`\x1b[31m${e.message}\x1b[0m\n`));

    return () => {
      disposed = true;
      onData.dispose();
      unsub();
      ro.disconnect();
      term.dispose();
    };
  }, [project, device, kind, session, autoFocus]);

  return <div ref={host} className="h-full w-full bg-[#05080f] p-1" data-terminal />;
}
