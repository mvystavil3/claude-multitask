import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { IPty } from 'node-pty';
import type { PaneState, PaneStatus, ResolvedPane } from '../shared/types.js';
import { getProfile, unavailableReason, type ShellProfile } from './profiles.js';
import { EventTail, eventsPath, prepareHooks, settingsPath } from './hooks.js';
import type { HookEvent, PaneActivity } from '../shared/types.js';

// Required at runtime rather than imported so a missing native build surfaces as a
// pane error instead of preventing the whole app from loading.
function pty(): typeof import('node-pty') {
  return require('node-pty');
}

const SHELL_QUIET_MS = 400;
/** A shell whose prompt does not end in a usual prompt character still counts once this quiet. */
const SHELL_FALLBACK_QUIET_MS = 2_500;
/** A cold WSL VM or a container starting up can take well over ten seconds. */
const SHELL_TIMEOUT_MS = 45_000;
const CLAUDE_TIMEOUT_MS = 60_000;
/** How long a pane waits for you to finish Claude's first-run setup before giving up. */
const CLAUDE_SETUP_WAIT_MS = 15 * 60_000;
/** An arbitrary command has no readiness marker, so settling output is the only signal. */
const COMMAND_QUIET_MS = 600;
const COMMAND_TIMEOUT_MS = 30_000;
/** Settle window after the TUI appears, so its first paint does not eat the keystrokes. */
const CLAUDE_SETTLE_QUIET_MS = 500;
const CLAUDE_SETTLE_MAX_MS = 6_000;

/**
 * Stripping ANSI also removes the cursor-movement sequences that rendered the spaces
 * between words, so readiness patterns are matched against whitespace-free text.
 */
const compact = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/**
 * Claude's TUI is only considered up once one of its own footer hints appears. Two traps
 * this avoids: output merely falling quiet (Claude is silent while Node boots, and a
 * prompt typed in that gap is swallowed), and the startup banner, which is also printed
 * by the onboarding wizard — matching it pastes the task into a menu.
 */
const CLAUDE_TUI = /(forshortcuts|shift\+tabtocycle|bypasspermissions|esctointerrupt|foragents)/;
/** The shell rejected the command — typing the task now would run it as a shell line. */
const CLAUDE_MISSING =
  /(commandnotfound|isnotrecognizedasaninternalorexternalcommand|commandnotfoundexception|nosuchfileordirectory)/;
/**
 * Claude is waiting on first-run setup rather than a prompt. Common in a container that
 * has no credentials of its own, where typing the task would answer a menu.
 */
const CLAUDE_SETUP =
  /(selectloginmethod|isthisaprojectyoucreated|darkmode\(ansicolorsonly\)|pressentertologin)/;

/**
 * The end of a shell prompt, on whitespace-free text: `C:\x>`, `PS C:\x>`, `user@host:~$`,
 * `root@abc:/work#`, zsh's `%`. Typing before the prompt exists works for cmd but WSL and
 * containers can drop or mangle input sent while they are still booting.
 */
const SHELL_PROMPT = /[>$#%]$/;

type Readiness = 'ready' | 'failed' | 'timeout';

interface WaitOptions {
  timeoutMs: number;
  /** Ready as soon as this matches — after `quietMs` of silence too, when that is set. */
  ready?: RegExp;
  /** Stops the wait with `failed`. Checked before `ready`. */
  fail?: RegExp;
  /** Output must have been quiet this long. Without `ready`, quiet alone means ready. */
  quietMs?: number;
  /** With `ready`: output this quiet counts as ready even without a match. */
  fallbackQuietMs?: number;
  /** Also stops the wait with `failed`, for conditions a pattern cannot express. */
  failWhen?: () => boolean;
}

/** How long the shell's prompt must sit unchanged before it counts as having come back. */
const PROMPT_RETURN_QUIET_MS = 1_500;
/** How much of the end of the prompt identifies it. */
const PROMPT_TAIL_CHARS = 24;

/** The last non-blank line of stripped output, compacted: the shell's prompt at a prompt. */
function lastLine(text: string): string {
  const lines = text.split(/[\r\n]+/).filter((l) => l.trim());
  return compact(lines[lines.length - 1] ?? '');
}

export interface SessionEvents {
  onData(id: string, chunk: string): void;
  onState(state: PaneState): void;
}

/** Strip ANSI/OSC so readiness regexes see plain text. */
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    // ConPTY starts new lines by moving the cursor (ESC[row;colH), not with a newline;
    // keep the line break so "the last line" means what is on screen.
    .replace(/\u001b\[\d*(;\d*)?[Hf]/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '');
}

/**
 * `pid` and all its descendants, leaves first, from one `ps` snapshot. POSIX only; an
 * unreadable process table degrades to just `pid`.
 */
function processTree(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
      const children = new Map<number, number[]>();
      if (!err) {
        for (const line of stdout.split('\n')) {
          const [child, parent] = line.trim().split(/\s+/).map(Number);
          if (!child || !parent) continue;
          children.set(parent, [...(children.get(parent) ?? []), child]);
        }
      }
      const tree: number[] = [];
      const visit = (p: number) => {
        for (const c of children.get(p) ?? []) visit(c);
        tree.push(p);
      };
      visit(pid);
      resolve(tree);
    });
  });
}

export class Session {
  readonly id: string;
  private pane: ResolvedPane;
  private readonly workspace: string;
  private readonly events: SessionEvents;

  private proc: IPty | null = null;
  private log: FileHandle | null = null;
  private state: PaneState;

  private cols = 80;
  private rows = 24;

  /** Rolling tail of stripped output, used by the readiness waiters. */
  private tail = '';
  private lastDataAt = 0;
  private sawData = false;
  private waiter: { timer: NodeJS.Timeout; cancel: () => void } | null = null;
  private disposed = false;
  private readonly eventTail: EventTail;
  /** Kept across restarts so the pane can resume its conversation. */
  private lastSessionId: string | undefined;

  constructor(
    pane: ResolvedPane,
    workspace: string,
    events: SessionEvents,
    size?: { cols: number; rows: number },
  ) {
    if (size) this.resize(size.cols, size.rows);
    this.id = pane.id;
    this.pane = pane;
    this.workspace = workspace;
    this.events = events;
    this.state = { id: pane.id, status: 'idle', promptSent: false, activity: 'unknown', turns: 0 };
    this.eventTail = new EventTail(eventsPath(workspace), (e) => this.handleHookEvent(e));
  }

  /**
   * Turn a hook event into pane state. `Stop` is the important one: Claude has finished
   * its turn, so the pane is now waiting on you.
   */
  private handleHookEvent(event: HookEvent): void {
    const patch: Partial<PaneState> = { lastEventAt: Date.now() };
    if (event.session_id) {
      patch.sessionId = event.session_id;
      this.lastSessionId = event.session_id;
    }

    let activity: PaneActivity | undefined;
    switch (event.hook_event_name) {
      case 'SessionStart':
        activity = 'ready';
        patch.turns = 0;
        break;
      case 'UserPromptSubmit':
        activity = 'working';
        patch.tool = undefined;
        patch.needsReason = undefined;
        break;
      case 'PreToolUse':
        activity = 'working';
        patch.tool = event.tool_name;
        break;
      case 'PostToolUse':
        activity = 'working';
        patch.tool = undefined;
        break;
      case 'Notification':
        // Also sent when Claude has merely sat idle at its prompt for a while, which is
        // not a permission request.
        activity = 'needs-you';
        patch.needsReason = /permission/i.test(event.message ?? '') ? 'permission' : 'turn-ended';
        break;
      case 'Stop':
        activity = 'needs-you';
        patch.needsReason = 'turn-ended';
        patch.tool = undefined;
        patch.turns = this.state.turns + 1;
        break;
      case 'SessionEnd':
        activity = 'ended';
        patch.tool = undefined;
        patch.needsReason = undefined;
        break;
    }
    if (activity) patch.activity = activity;
    this.setState(patch);
  }

  get currentState(): PaneState {
    return this.state;
  }

  get isAlive(): boolean {
    return this.proc !== null;
  }

  /**
   * Hooks write to a file in the pane's folder, so they only work where that folder is
   * visible to Claude. A docker exec pane attaches to a container that never had it mounted.
   */
  private hooksEnabled(profile: ShellProfile): boolean {
    return profile.hooksReachable?.(this.pane) ?? true;
  }

  /** Config edits apply to the next start; a live PTY keeps the config it began with. */
  updateConfig(pane: ResolvedPane): void {
    this.pane = pane;
  }

  private setState(patch: Partial<PaneState>): void {
    this.state = { ...this.state, ...patch };
    this.events.onState(this.state);
  }

  private fail(status: PaneStatus, message: string): void {
    this.setState({ status, message });
    this.events.onData(this.id, `\r\n\u001b[31m[multitask] ${message}\u001b[0m\r\n`);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.disposed = false;
    this.tail = '';
    this.sawData = false;
    this.setState({
      status: 'spawning',
      promptSent: false,
      exitCode: undefined,
      message: undefined,
      activity: 'unknown',
      tool: undefined,
      needsReason: undefined,
      turns: 0,
    });

    let spawned: IPty;
    const profile = getProfile(this.pane.profile);
    // A config copied from another OS can name a shell this machine does not have.
    const unavailable = unavailableReason(this.pane.profile);
    if (unavailable) {
      this.fail('error', unavailable);
      return;
    }
    try {
      await mkdir(path.join(this.workspace, '.multitask'), { recursive: true });
      this.log = await open(path.join(this.workspace, '.multitask', 'session.log'), 'a');
      await this.log.write(
        `\n===== ${new Date().toISOString()} ${this.pane.profile} ${this.pane.id} =====\n`,
      );

      // Docker checks the engine, the image and the credential mounts here, so a
      // misconfigured container fails with a clear message instead of a dead terminal.
      await profile.prepare?.(this.pane, this.workspace);
      if (this.disposed) return;

      if (this.pane.launch === 'claude' && this.hooksEnabled(profile)) {
        await prepareHooks(
          this.pane,
          this.workspace,
          profile.shellPath(this.pane, eventsPath(this.workspace), this.workspace),
        );
        this.eventTail.start();
      }
      const spec = profile.buildSpawn(this.pane, this.workspace);
      spawned = pty().spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: spec.cwd,
        env: spec.env,
        useConpty: true,
      });
    } catch (err) {
      this.fail('error', (err as Error).message);
      await this.closeLog();
      await profile.cleanup?.(this.pane).catch(() => {});
      return;
    }

    this.proc = spawned;
    this.setState({
      status: 'spawning',
      pid: spawned.pid,
      startedAt: Date.now(),
      message: profile.warningFor?.(this.pane),
    });

    spawned.onData((chunk) => this.handleData(chunk));
    spawned.onExit(({ exitCode }) => {
      this.cancelWaiter();
      this.eventTail.stop();
      this.proc = null;
      void this.closeLog();
      void profile.cleanup?.(this.pane).catch(() => {});
      if (!this.disposed) this.setState({ status: 'exited', exitCode, pid: undefined });
    });

    void this.runLaunchSequence();
  }

  private handleData(chunk: string): void {
    const text = stripAnsi(chunk);
    // ConPTY opens every session with a burst of mode and clear-screen sequences before the
    // shell has run at all; only visible text means the program has said something.
    if (text.trim()) this.sawData = true;
    this.lastDataAt = Date.now();
    this.tail = (this.tail + text).slice(-4000);
    this.events.onData(this.id, chunk);
    void this.log?.write(chunk).catch(() => {});
  }

  /** Wait until the terminal looks ready; see WaitOptions for what "ready" can mean. */
  private waitForReady(opts: WaitOptions): Promise<Readiness> {
    this.cancelWaiter();
    return new Promise<Readiness>((resolve) => {
      const deadline = Date.now() + opts.timeoutMs;
      const finish = (outcome: Readiness) => {
        clearInterval(timer);
        if (this.waiter?.timer === timer) this.waiter = null;
        resolve(outcome);
      };
      const quietFor = (ms: number) => this.sawData && Date.now() - this.lastDataAt >= ms;
      const timer = setInterval(() => {
        if (!this.proc || this.disposed) return finish('timeout');
        const text = compact(this.tail);
        if (opts.fail?.test(text) || opts.failWhen?.()) return finish('failed');
        const quiet = opts.quietMs === undefined || quietFor(opts.quietMs);
        if (opts.ready) {
          if (opts.ready.test(text) && quiet) return finish('ready');
          if (opts.fallbackQuietMs !== undefined && quietFor(opts.fallbackQuietMs)) {
            return finish('ready');
          }
        } else if (opts.quietMs !== undefined && quiet) {
          return finish('ready');
        }
        if (Date.now() >= deadline) return finish('timeout');
      }, 100);
      this.waiter = { timer, cancel: () => finish('timeout') };
    });
  }

  /** Poll until `check` passes or the timeout expires. Independent of the stage waiter. */
  private poll(check: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (!this.proc || this.disposed) {
          clearInterval(timer);
          return resolve(false);
        }
        if (check()) {
          clearInterval(timer);
          return resolve(true);
        }
        if (Date.now() >= deadline) {
          clearInterval(timer);
          return resolve(false);
        }
      }, 100);
    });
  }

  private cancelWaiter(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.cancel();
  }

  private async runLaunchSequence(): Promise<void> {
    const profile = getProfile(this.pane.profile);

    const shellReady = await this.waitForReady({
      timeoutMs: SHELL_TIMEOUT_MS,
      ready: SHELL_PROMPT,
      quietMs: SHELL_QUIET_MS,
      fallbackQuietMs: SHELL_FALLBACK_QUIET_MS,
    });
    if (!this.proc || this.disposed) return;
    if (shellReady !== 'ready') {
      this.fail('error', 'Shell did not produce a prompt in time.');
      return;
    }
    this.setState({ status: 'shell-ready' });
    // Remembered so a command that ends straight away can be recognised by the prompt
    // reappearing. Error text is localised ("wird nicht als interner oder externer Befehl"),
    // the shell's own prompt is not.
    // Only its end is compared: shells and line editors sometimes repaint the start of the
    // line, but the text right before the cursor (`…\project>`, `…:~/x$`) stays put.
    const prompt = lastLine(this.tail).slice(-PROMPT_TAIL_CHARS);

    // 'shell' means the pane is just a terminal: type nothing, let the user drive.
    if (this.pane.launch === 'shell') {
      this.setState({ status: 'running' });
      return;
    }

    const isClaude = this.pane.launch === 'claude';
    let command: string;
    try {
      command = isClaude
        ? profile.claudeCommand(
            { ...this.pane, resumeSessionId: this.lastSessionId },
            this.hooksEnabled(profile)
              ? profile.shellPath(this.pane, settingsPath(this.workspace), this.workspace)
              : undefined,
          )
        : this.pane.command.trim();
    } catch (err) {
      this.fail('error', (err as Error).message);
      return;
    }
    if (!command) {
      this.fail('error', 'This pane has no command to run. Set one in Settings.');
      return;
    }

    this.tail = '';
    this.sawData = false;
    this.write(command + profile.newline);
    this.setState({ status: 'launching' });

    // Claude announces itself with a footer hint; an arbitrary command has no such
    // marker, so for those we wait for the output to settle instead.
    let ready = isClaude
      ? await this.waitForReady({
          timeoutMs: CLAUDE_TIMEOUT_MS,
          ready: CLAUDE_TUI,
          // Either failure mode must stop the launch before the task is typed anywhere.
          fail: new RegExp(`${CLAUDE_MISSING.source}|${CLAUDE_SETUP.source}`),
          // Claude never hands the terminal back while it is starting, so a prompt that
          // returns and stays means the command ended, whatever language it failed in.
          // Very short prompts ("$") are too ambiguous to go on.
          failWhen: () =>
            prompt.length >= 2 &&
            Date.now() - this.lastDataAt >= PROMPT_RETURN_QUIET_MS &&
            compact(this.tail).endsWith(prompt),
        })
      : await this.waitForReady({
          timeoutMs: COMMAND_TIMEOUT_MS,
          quietMs: COMMAND_QUIET_MS,
          fail: CLAUDE_MISSING,
        });
    if (!this.proc || this.disposed) return;

    if (ready === 'failed' && isClaude && CLAUDE_SETUP.test(compact(this.tail))) {
      // Claude itself is up and waiting on a login or folder-trust dialog. Nothing is
      // broken, so the pane stays 'running'; once you finish the dialog by hand its
      // footer appears and the task goes out as if the launch had been clean.
      const hasTask = this.pane.autoSubmit && this.pane.task.trim();
      this.setState({
        status: 'running',
        message:
          'Claude is asking for first-run setup (login or folder trust). Finish it in this ' +
          'pane' +
          (hasTask ? ' and the task will be sent automatically.' : '.'),
      });
      this.tail = '';
      ready = await this.waitForReady({ timeoutMs: CLAUDE_SETUP_WAIT_MS, ready: CLAUDE_TUI });
      if (!this.proc || this.disposed) return;
    }

    if (ready === 'failed') {
      this.fail(
        'error',
        `The shell could not run "${command}".` +
          (isClaude
            ? ' Install Claude Code for this shell, or set the pane’s claude executable ' +
              'path in Settings. The shell is still usable.'
            : ' Check the command in Settings. The shell is still usable.'),
      );
      return;
    }
    if (ready === 'timeout') {
      this.setState({
        status: 'running',
        message: isClaude
          ? 'Claude did not signal readiness; send the prompt manually.'
          : 'The command is still producing output; nothing was sent to it automatically.',
      });
      return;
    }
    this.setState({ status: 'running', message: undefined });

    if (this.pane.autoSubmit && this.pane.task.trim()) {
      await this.sendPrompt();
    }
  }

  /**
   * Send the task to whatever the pane started.
   *
   * Claude's TUI understands a bracketed paste, which is what keeps a multi-line task as
   * one message; it also echoes the text, so delivery can be confirmed before Enter.
   * Anything else reading stdin — a REPL, a shell, `cat` — receives those brackets as raw
   * escape bytes and swallows the input, so those get plain lines instead.
   */
  async sendPrompt(text = this.pane.task): Promise<void> {
    if (!this.proc || !text.trim()) return;
    const body = text.replace(/\r\n/g, '\n');

    // Let the program finish painting before typing into it.
    await this.poll(
      () => Date.now() - this.lastDataAt >= CLAUDE_SETTLE_QUIET_MS,
      CLAUDE_SETTLE_MAX_MS,
    );
    if (!this.proc || this.disposed) return;

    if (this.pane.launch !== 'claude') {
      for (const line of body.split('\n')) {
        this.write(line + '\r');
        await new Promise((r) => setTimeout(r, 80));
        if (!this.proc || this.disposed) return;
      }
      this.setState({ promptSent: true });
      return;
    }

    // The prompt box shows the pasted text, so its opening characters are the receipt.
    const needle = compact(body).slice(0, 24);
    let delivered = false;
    for (let attempt = 0; attempt < 2 && !delivered; attempt += 1) {
      this.tail = '';
      this.write(`\u001b[200~${body}\u001b[201~`);
      delivered = await this.poll(() => compact(this.tail).includes(needle), 3000);
      if (!this.proc || this.disposed) return;
    }

    this.write('\r');
    this.setState({
      promptSent: true,
      message: delivered
        ? undefined
        : 'The text may not have reached the prompt; check the pane and resend if needed.',
    });
  }

  write(data: string): void {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(2, Math.floor(cols));
    this.rows = Math.max(2, Math.floor(rows));
    try {
      this.proc?.resize(this.cols, this.rows);
    } catch {
      /* the PTY may have exited between the renderer's measure and this call */
    }
  }

  async stop(hard = false): Promise<void> {
    this.cancelWaiter();
    const proc = this.proc;
    if (!proc) return;
    const pid = proc.pid;
    // On POSIX the shell's children are reparented to init the moment it exits, after which
    // they can no longer be found from its pid, so the tree is read before anything dies.
    const tree = process.platform === 'win32' ? null : await processTree(pid);

    const exited = new Promise<void>((resolve) => {
      const sub = proc.onExit(() => {
        sub.dispose();
        resolve();
      });
    });
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    if (!hard) await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    // Always sweep the tree: killing the shell does not reliably take claude and its node
    // child with it. ConPTY leaves them running on Windows, and on POSIX an interactive
    // shell puts each job in its own process group, out of reach of the shell's hangup.
    if (tree) {
      for (const p of tree) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    } else {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    }
  }

  /** Forget the remembered conversation, so the next start is a fresh session. */
  clearSession(): void {
    this.lastSessionId = undefined;
    this.setState({ sessionId: undefined });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.eventTail.stop();
    await this.stop();
    await this.closeLog();
  }

  private async closeLog(): Promise<void> {
    const log = this.log;
    this.log = null;
    await log?.close().catch(() => {});
  }
}
