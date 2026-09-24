import { BrowserWindow, Notification, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import type {
  AppConfig,
  DockerStatus,
  PaneState,
  Preflight,
  ResolvedPane,
} from '../shared/types.js';
import type { Snapshot } from '../shared/ipc.js';
import { IPC } from '../shared/ipc.js';
import { Session } from './session.js';
import {
  appRoot,
  configPath,
  loadConfig,
  resolvePanes,
  saveConfig,
  workspacePath,
} from './config.js';
import { findClaude, findPwsh, listWslDistros } from './profiles.js';
import { ResourceMonitor } from './resources.js';
import {
  buildImage,
  containerExists,
  dockerStatus,
  loadImage,
  pullImage,
  removeContainer,
} from './docker.js';

/** Output kept per pane so a terminal created after a pane started still shows history. */
const REPLAY_LIMIT = 256 * 1024;

export class Manager {
  private config: AppConfig;
  private panes: ResolvedPane[] = [];
  private sessions = new Map<string, Session>();
  private replay = new Map<string, string>();
  /**
   * The folder each live session was created against. A Session binds to its workspace for
   * its whole life, so moving a pane to another project has to replace the Session rather
   * than update it.
   */
  private sessionWorkspace = new Map<string, string>();
  /** Previous activity per pane, so a notification fires on the transition only. */
  private lastActivity = new Map<string, PaneState['activity']>();
  /**
   * Last terminal size the renderer reported per pane. The renderer measures a pane as soon
   * as it is laid out, usually before its session exists, so the size has to be kept here
   * or every pane would start at 80x24 until the window next changed size.
   */
  private sizes = new Map<string, { cols: number; rows: number }>();
  private readonly resources = new ResourceMonitor(
    (sample) => this.send(IPC.onResources, sample),
    () => this.liveCount(),
  );
  private win: BrowserWindow | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.panes = resolvePanes(config);
  }

  attachWindow(win: BrowserWindow): void {
    this.win = win;
    this.resources.start();
  }

  stopResources(): void {
    this.resources.stop();
  }

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    this.send(IPC.onToast, { message, kind });
  }

  snapshot(): Snapshot {
    return {
      config: this.config,
      panes: this.panes,
      states: this.panes.map(
        (p) =>
          this.sessions.get(p.id)?.currentState ?? {
            id: p.id,
            status: 'idle',
            promptSent: false,
            activity: 'unknown',
            turns: 0,
          },
      ),
    };
  }

  async preflight(): Promise<Preflight> {
    const [wslDistros, docker] = await Promise.all([listWslDistros(), dockerStatus()]);
    return {
      claudeOnPath: findClaude(),
      pwshOnPath: findPwsh(),
      wslDistros,
      docker,
      appRoot: appRoot(),
      configPath: configPath(),
    };
  }

  /** Docker image management. Output is streamed to the renderer as it arrives. */
  private dockerLog = (line: string) => this.send(IPC.onDockerLog, { line });

  dockerStatus(): Promise<DockerStatus> {
    return dockerStatus();
  }

  async dockerPull(ref: string): Promise<boolean> {
    return (await pullImage(ref, this.dockerLog)).ok;
  }

  async dockerBuild(tag: string, baseImage: string): Promise<boolean> {
    return (await buildImage(tag, baseImage, this.dockerLog)).ok;
  }

  async dockerLoad(tarPath: string): Promise<boolean> {
    return (await loadImage(tarPath, this.dockerLog)).ok;
  }

  private pane(id: string): ResolvedPane {
    const p = this.panes.find((x) => x.id === id);
    if (!p) throw new Error(`No pane with id "${id}".`);
    return p;
  }

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      const pane = this.pane(id);
      const workspace = workspacePath(pane);
      this.sessionWorkspace.set(id, workspace);
      s = new Session(
        pane,
        workspace,
        {
          onData: (paneId, chunk) => {
            const prev = this.replay.get(paneId) ?? '';
            const next = prev + chunk;
            this.replay.set(paneId, next.length > REPLAY_LIMIT ? next.slice(-REPLAY_LIMIT) : next);
            this.send(IPC.onData, { id: paneId, chunk });
          },
          onState: (state: PaneState) => {
            this.notifyIfNeeded(state);
            this.send(IPC.onState, state);
          },
        },
        this.sizes.get(id),
      );
      this.sessions.set(id, s);
    }
    return s;
  }

  /**
   * Tell the user a pane wants them, but only when they are looking elsewhere. Inside the
   * app the pane's own border and the toolbar counter already say it.
   */
  private notifyIfNeeded(state: PaneState): void {
    const was = this.lastActivity.get(state.id);
    this.lastActivity.set(state.id, state.activity);
    if (state.activity !== 'needs-you' || was === 'needs-you') return;
    if (!Notification.isSupported()) return;
    if (this.win && !this.win.isDestroyed() && this.win.isFocused()) return;

    const pane = this.panes.find((p) => p.id === state.id);
    const title = pane?.title ?? state.id;
    new Notification({
      title: `${title} needs you`,
      body:
        state.needsReason === 'permission'
          ? 'Claude is asking for permission.'
          : 'Claude finished its turn and is waiting.',
      silent: true,
    }).show();
  }

  private forgetSession(id: string): void {
    this.sessions.delete(id);
    this.replay.delete(id);
    this.sessionWorkspace.delete(id);
    this.lastActivity.delete(id);
  }

  replayFor(id: string): string {
    return this.replay.get(id) ?? '';
  }

  async ensureWorkspaces(): Promise<void> {
    for (const pane of this.panes) {
      await mkdir(workspacePath(pane), { recursive: true }).catch(() => {});
    }
  }

  /**
   * Remove containers left over from a previous session. `docker run --rm` only fires when
   * the container itself stops, so force-killing the app leaves its containers up — and
   * they keep a lock on the bind-mounted workspace folders.
   */
  async sweepStaleContainers(): Promise<void> {
    const names = this.panes
      .filter((p) => p.profile === 'docker' && p.docker.mode === 'run')
      .map((p) => p.docker.containerName);
    for (const name of new Set(names)) {
      if (await containerExists(name).catch(() => false)) {
        await removeContainer(name).catch(() => {});
        this.toast(`Removed a leftover container from a previous session: ${name}`);
      }
    }
  }

  async start(id: string): Promise<void> {
    this.replay.set(id, '');
    await this.session(id).start();
  }

  async stop(id: string): Promise<void> {
    await this.sessions.get(id)?.stop();
  }

  async restart(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s?.isAlive) {
      await s.stop(true);
      // Give ConPTY a moment to release the pipe before respawning.
      await new Promise((r) => setTimeout(r, 600));
    }
    await this.start(id);
  }

  async startAll(): Promise<void> {
    // Stagger so several Claude processes do not all boot into the same CPU spike.
    for (const pane of this.panes) {
      if (!this.sessions.get(pane.id)?.isAlive) {
        await this.start(pane.id);
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }

  async restartAll(): Promise<void> {
    await this.stopAll();
    await new Promise((r) => setTimeout(r, 800));
    await this.startAll();
  }

  /** Drop the remembered conversation so the pane starts a brand new session. */
  async freshSession(id: string): Promise<void> {
    this.sessions.get(id)?.clearSession();
    await this.restart(id);
  }

  sendPrompt(id: string, text?: string): void {
    this.sessions.get(id)?.sendPrompt(text);
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sizes.set(id, { cols, rows });
    this.sessions.get(id)?.resize(cols, rows);
  }

  hasLiveSessions(): boolean {
    return [...this.sessions.values()].some((s) => s.isAlive);
  }

  liveCount(): number {
    return [...this.sessions.values()].filter((s) => s.isAlive).length;
  }

  async autoStart(): Promise<void> {
    for (const pane of this.panes) {
      if (pane.autoStart) {
        await this.start(pane.id);
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  /** Apply a new config: persist it, drop sessions for removed panes, keep the rest. */
  async applyConfig(config: AppConfig, persist = true): Promise<void> {
    if (persist) await saveConfig(config);
    this.config = config;
    this.panes = resolvePanes(config);
    const ids = new Set(this.panes.map((p) => p.id));

    for (const [id, session] of [...this.sessions]) {
      if (!ids.has(id)) {
        await session.dispose();
        this.forgetSession(id);
      }
    }

    for (const pane of this.panes) {
      const session = this.sessions.get(pane.id);
      if (!session) continue;

      const moved = this.sessionWorkspace.get(pane.id) !== workspacePath(pane);
      if (moved) {
        // Dropping the Session also drops the Claude session id it remembered, which is
        // what we want: that conversation belongs to the folder the pane just left.
        const wasRunning = session.isAlive;
        await session.dispose();
        this.forgetSession(pane.id);
        this.toast(
          `${pane.title} now works in ${workspacePath(pane)}` +
            (wasRunning ? ' — its terminal was stopped, start it again when ready.' : '.'),
        );
        continue;
      }
      session.updateConfig(pane);
    }
    await this.ensureWorkspaces();
    this.send(IPC.onConfig, this.snapshot());
  }

  /** Re-read the config file from disk (used by the watcher and the Reload button). */
  async reloadFromDisk(): Promise<void> {
    const { config, error } = await loadConfig();
    if (error) {
      this.toast(`Config file is invalid, keeping the current one: ${error}`, 'error');
      return;
    }
    await this.applyConfig(config, false);
    this.toast('Config reloaded from disk.');
  }

  async openWorkspace(id: string): Promise<void> {
    const dir = workspacePath(this.pane(id));
    await mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
  }

  async openConfigFile(): Promise<void> {
    await shell.openPath(configPath());
  }

  async disposeAll(): Promise<void> {
    this.resources.stop();
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
    this.sessions.clear();
    this.sessionWorkspace.clear();
  }
}
