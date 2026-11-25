import type { Network, RtDevice } from '../sim/network';
import { type5Verify } from '../util/secrets';
import type { IosConfig } from './config';
import { treesFor } from './commands';
import { complete, help, match, type MatchResult, type Tree } from './parser';

export type Mode = 'user' | 'priv' | 'config' | 'config-if' | 'config-if-range' | 'config-subif' | 'config-line' | 'config-vlan' | 'config-router' | 'config-dhcp' | 'config-dhcp6' | 'config-acl';

export interface Ctx {
  s: IosSession;
  d: RtDevice;
  c: IosConfig;
  net: Network;
  /** True when the command was entered with a leading `no`. */
  neg: boolean;
  out(...lines: string[]): void;
  /** Reject the command as IOS does for input that is syntactically valid but not applicable here. */
  invalid(at?: number): void;
}

interface Pending {
  prompt: string;
  secret: boolean;
  handle(answer: string): void;
}

const PROMPT_SUFFIX: Record<Mode, string> = {
  user: '>',
  priv: '#',
  config: '(config)#',
  'config-if': '(config-if)#',
  'config-if-range': '(config-if-range)#',
  'config-subif': '(config-subif)#',
  'config-line': '(config-line)#',
  'config-vlan': '(config-vlan)#',
  'config-router': '(config-router)#',
  'config-dhcp': '(dhcp-config)#',
  'config-dhcp6': '(config-dhcpv6)#',
  'config-acl': '(config-ext-nacl)#',
};

export class IosSession {
  mode: Mode = 'user';
  targets: string[] = [];
  lineTarget: 'con' | 'vty' = 'con';
  vlanTargets: number[] = [];
  routerTarget: 'rip' | 'ospf' | 'ospf6' = 'rip';
  dhcpTarget = '';
  dhcp6Target = '';
  aclTarget = '';
  /** Remote (Telnet/SSH) session ended with exit/logout. */
  closed = false;
  history: string[] = [];
  termLength = 24;
  /** Console session waits for RETURN before showing the banner and login. */
  awaitingReturn: boolean;
  private pending: Pending | null = null;
  private outBuf: string[] = [];
  private lastPromptLen = 0;
  /** Set while a command handler reports an error (used by the config loader). */
  failed = false;

  constructor(
    public net: Network,
    public devId: string,
    public opts: { replay?: boolean; dev?: RtDevice; vty?: { proto: 'telnet' | 'ssh'; user?: string } } = {},
  ) {
    this.awaitingReturn = !opts.replay && !opts.vty;
    if (opts.replay) this.mode = 'config';
  }

  get dev(): RtDevice {
    return this.opts.dev ?? this.net.dev(this.devId);
  }

  get cfg(): IosConfig {
    return this.dev.ios!;
  }

  /** The text the terminal should show before the cursor. */
  prompt(): string {
    if (this.awaitingReturn) return '';
    if (this.pending) return this.pending.prompt;
    return this.cfg.hostname + PROMPT_SUFFIX[this.mode];
  }

  isSecretInput(): boolean {
    return !!this.pending?.secret;
  }

  out(...lines: string[]): void {
    this.outBuf.push(...lines);
  }

  ask(prompt: string, handle: (answer: string) => void, secret = false): void {
    this.pending = { prompt, secret, handle };
  }

  /** Called when the terminal is (re)opened. */
  greeting(): string {
    return this.awaitingReturn ? '\nPress RETURN to get started.\n' : '';
  }

  /** Processes one line of input and returns the text to print (without the next prompt). */
  input(raw: string): string {
    this.outBuf = [];
    this.failed = false;
    this.lastPromptLen = this.prompt().length;
    if (!this.opts.replay && !this.dev.doc.powered) return '';
    if (this.awaitingReturn) {
      this.awaitingReturn = false;
      this.startLogin();
      return this.flush();
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.handle(raw);
      return this.flush();
    }
    const line = raw.replace(/\t/g, ' ');
    if (!line.trim()) return this.flush();
    if (!this.opts.replay) {
      this.history.push(line.trim());
      if (this.history.length > 20) this.history.shift();
    }
    this.execute(line);
    return this.flush();
  }

  private flush(): string {
    const s = this.outBuf.join('\n');
    this.outBuf = [];
    return s;
  }

  /** Called once when a Telnet/SSH client connects to a VTY line. */
  openVty(): string {
    this.outBuf = [];
    const c = this.cfg;
    const v = c.vty;
    const proto = this.opts.vty!.proto;
    if (c.bannerMotd !== undefined) this.out(c.bannerMotd);
    if (proto === 'ssh') {
      const u = c.users.find((x) => x.name === this.opts.vty!.user);
      if (v.login !== 'local' || !u) {
        this.out('% Authentication failed');
        this.closed = true;
        return this.flush();
      }
      this.ask('Password: ', (pw) => {
        if (u.secret ? type5Verify(pw, u.secret) : u.password === pw) {
          if (u.privilege >= 15) this.mode = 'priv';
          return;
        }
        this.out('% Authentication failed');
        this.closed = true;
      }, true);
      return this.flush();
    }
    if (v.login === 'line') {
      if (v.password === undefined) {
        this.out('', 'Password required, but none set');
        this.closed = true;
        return this.flush();
      }
      this.out('', 'User Access Verification', '');
      const attempt = (tries: number) =>
        this.ask('Password: ', (pw) => {
          if (pw === v.password) return;
          if (tries > 1) return attempt(tries - 1);
          this.out('% Bad passwords');
          this.closed = true;
        }, true);
      attempt(3);
    } else if (v.login === 'local') {
      this.out('', 'User Access Verification', '');
      this.ask('Username: ', (user) =>
        this.ask('Password: ', (pw) => {
          const u = c.users.find((x) => x.name === user);
          if (u && (u.secret ? type5Verify(pw, u.secret) : u.password === pw)) {
            if (u.privilege >= 15) this.mode = 'priv';
            return;
          }
          this.out('% Login invalid');
          this.closed = true;
        }, true),
      );
    }
    return this.flush();
  }

  private startLogin(): void {
    const c = this.cfg;
    if (c.bannerMotd !== undefined) this.out(c.bannerMotd);
    const con = c.con;
    if (con.login === 'line' && con.password !== undefined) {
      this.out('', 'User Access Verification', '');
      this.loginPassword(3);
    } else if (con.login === 'local' && c.users.length) {
      this.out('', 'User Access Verification', '');
      this.loginLocal(3);
    }
  }

  private loginPassword(tries: number): void {
    this.ask('Password: ', (pw) => {
      if (pw === this.cfg.con.password) return;
      if (tries > 1) return this.loginPassword(tries - 1);
      this.out('% Bad passwords');
      this.awaitingReturn = true;
      this.out('', 'Press RETURN to get started.');
    }, true);
  }

  private loginLocal(tries: number): void {
    this.ask('Username: ', (user) => {
      this.ask('Password: ', (pw) => {
        const u = this.cfg.users.find((x) => x.name === user);
        const ok = !!u && (u.secret ? type5Verify(pw, u.secret) : u.password === pw);
        if (ok) {
          if (u!.privilege >= 15) this.mode = 'priv';
          return;
        }
        this.out('% Login invalid', '');
        if (tries > 1) return this.loginLocal(tries - 1);
        this.awaitingReturn = true;
        this.out('', 'Press RETURN to get started.');
      }, true);
    });
  }

  /** `enable`: password check against enable secret (preferred) or enable password. */
  enable(): void {
    const c = this.cfg;
    if (!c.enableSecret && !c.enablePassword) {
      // Over Telnet/SSH IOS refuses privileged mode without an enable password.
      if (this.opts.vty) return this.out('% No password set');
      this.mode = 'priv';
      return;
    }
    const attempt = (tries: number) =>
      this.ask('Password: ', (pw) => {
        const ok = c.enableSecret ? type5Verify(pw, c.enableSecret) : pw === c.enablePassword;
        if (ok) {
          this.mode = 'priv';
          return;
        }
        if (tries > 1) return attempt(tries - 1);
        this.out(c.enableSecret ? '% Bad secrets' : '% Bad passwords');
      }, true);
    attempt(3);
  }

  logout(): void {
    this.mode = 'user';
    this.targets = [];
    if (this.opts.replay) return;
    if (this.opts.vty) {
      this.closed = true;
      return;
    }
    this.awaitingReturn = true;
    this.out('', `${this.cfg.hostname} con0 is now available`, '', '', '', '', '', 'Press RETURN to get started.');
  }

  endConfig(): void {
    if (this.mode === 'user' || this.mode === 'priv') return;
    this.mode = 'priv';
    this.targets = [];
    if (!this.opts.replay) this.net.console(this.devId, '%SYS-5-CONFIG_I: Configured from console by console');
  }

  trees(): Record<Mode, Tree<Ctx>> {
    return treesFor(this.dev.kind);
  }

  private ctx(): Ctx {
    return {
      s: this,
      d: this.dev,
      c: this.cfg,
      net: this.net,
      neg: false,
      out: (...l) => this.out(...l),
      invalid: (at = 0) => this.reportError({ ok: false, error: 'invalid', at }, this.lastLine),
    };
  }

  private lastLine = '';

  /** Runs a command; in configuration sub-modes falls back to the parent modes as IOS does. */
  execute(line: string): void {
    this.lastLine = line;
    const trees = this.trees();
    const chain: Mode[] = [this.mode];
    if (this.mode.startsWith('config-')) chain.push('config');
    let first: MatchResult<Ctx> | null = null;
    for (const m of chain) {
      const r = match(trees[m], line);
      if (r.ok) {
        if (m !== this.mode) {
          this.mode = m;
          this.targets = [];
        }
        const ctx = this.ctx();
        ctx.neg = r.args.kw[0] === 'no';
        r.run(ctx, r.args);
        if (!this.opts.replay) this.net.refresh();
        return;
      }
      first ??= r;
    }
    this.reportError(first!, line);
  }

  reportError(r: MatchResult<Ctx>, line: string): void {
    if (r.ok) return;
    this.failed = true;
    if (r.error === 'ambiguous') return this.out(`% Ambiguous command:  "${line.trim()}"`);
    if (r.error === 'incomplete') return this.out('% Incomplete command.', '');
    const tokens = [...line.matchAll(/\S+/g)];
    const col = tokens[r.at]?.index ?? line.length;
    if ((this.mode === 'user' || this.mode === 'priv') && r.at === 0) {
      const word = tokens[0]?.[0] ?? '';
      if (tokens.length === 1 && this.cfg.domainLookup) this.out(`Translating "${word}"...domain server (255.255.255.255)`);
      return this.out('% Unknown command or computer name, or unable to find computer address');
    }
    this.out(' '.repeat(this.lastPromptLen + col) + '^', "% Invalid input detected at '^' marker.", '');
  }

  /** Contextual help for a line ending with `?` (the `?` itself excluded). */
  help(lineBeforeQ: string): string {
    if (this.pending || this.awaitingReturn) return '';
    const trees = this.trees();
    const h = help(trees[this.mode], lineBeforeQ);
    if ('error' in h) {
      if (h.error.ok === false && h.error.error === 'ambiguous') return `% Ambiguous command:  "${lineBeforeQ.trim()}"`;
      return '% Unrecognized command';
    }
    if (!h.entries.length) return '% Unrecognized command';
    if (h.partial) return h.entries.map((e) => e.word).join('  ');
    const width = Math.max(...h.entries.map((e) => e.word.length));
    return h.entries.map((e) => `  ${e.word.padEnd(width)}  ${e.help}`.trimEnd()).join('\n');
  }

  complete(line: string): string | null {
    if (this.pending || this.awaitingReturn) return null;
    return complete(this.trees()[this.mode], line);
  }

  /** IOS-style prompt for "copy run start" and friends. */
  confirm(prompt: string, onYes: () => void): void {
    this.ask(prompt, (a) => {
      const t = a.trim().toLowerCase();
      if (t === '' || t === 'y' || t === 'yes' || t === 'confirm') onYes();
    });
  }
}
