export type ProfileId = 'cmd' | 'powershell' | 'wsl' | 'docker' | 'posix' | 'ssh';

/**
 * Shells in the order Settings lists them, with the platforms each one exists on. Shared so
 * the main process and the settings dialog agree on what a machine can run.
 */
export const PROFILES: { id: ProfileId; label: string; platforms?: string[] }[] = [
  { id: 'posix', label: 'Login shell ($SHELL)', platforms: ['darwin', 'linux'] },
  { id: 'cmd', label: 'Windows cmd', platforms: ['win32'] },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'wsl', label: 'WSL', platforms: ['win32'] },
  { id: 'docker', label: 'Docker container' },
  { id: 'ssh', label: 'SSH (remote host)' },
];

export function profileAvailable(id: ProfileId, platform: string): boolean {
  const entry = PROFILES.find((p) => p.id === id);
  return !!entry && (!entry.platforms || entry.platforms.includes(platform));
}

/** What a fresh config uses: cmd on Windows, the user's own shell elsewhere. */
export function defaultProfileFor(platform: string): ProfileId {
  return platform === 'win32' ? 'cmd' : 'posix';
}

export type PaneStatus =
  | 'idle'
  | 'spawning'
  | 'shell-ready'
  | 'launching'
  | 'running'
  | 'exited'
  | 'error';

/**
 * What the pane types into its shell once the shell is ready.
 * - `claude`: build a `claude` invocation from model/claudeArgs/claudeBin, wait for its
 *   TUI, then send the task. The default.
 * - `command`: type `command` verbatim, wait for its output to settle, then send `task`
 *   if there is one. Anything goes here — `ls`, `pwd`, `npm test`, another REPL.
 * - `shell`: type nothing and leave the shell for you to drive.
 */
export type LaunchMode = 'claude' | 'command' | 'shell';

/**
 * How a docker pane gets Claude Code's credentials.
 * - `shared`: bind-mount the host's ~/.claude and ~/.claude.json. Simplest, and onboarding
 *   is already done, but every pane writes to the same files as the host.
 * - `copy`: give the pane its own Claude home under its workspace, seeded once from the
 *   host's credentials. Isolated; the host's config is never written to.
 * - `none`: mount nothing. The container must authenticate itself, normally by inheriting
 *   ANTHROPIC_API_KEY from the environment.
 */
export type ClaudeConfigMode = 'shared' | 'copy' | 'none';

export interface DockerConfig {
  /** Image to run. Must already exist locally; use the Images dialog to build or pull it. */
  image?: string;
  /** `run` starts a fresh container; `exec` attaches to a container that is already up. */
  mode?: 'run' | 'exec';
  /** Container to attach to in `exec` mode, or the name given to the `run` container. */
  containerName?: string;
  /** Where the pane's folder is mounted, and the shell's working directory. */
  workdir?: string;
  /** Shell argv inside the container. */
  shell?: string[];
  claudeConfigMode?: ClaudeConfigMode;
  /** Claude's home directory inside the container; depends on the image's user. */
  claudeHome?: string;
  /** Extra arguments inserted before the image name, e.g. --network=none, --memory=4g. */
  extraArgs?: string[];
  /** Passed as `docker run --user`, e.g. "1000:1000". */
  user?: string;
}

/** Where an ssh pane connects. Authentication is ssh's own: keys, agent, ~/.ssh/config. */
export interface SshConfig {
  /** Host to connect to: `host`, `user@host`, or an alias from ~/.ssh/config. */
  host?: string;
  port?: number;
  /** Private key passed as `ssh -i`. */
  identityFile?: string;
  /** Folder on the remote host to start in; the remote login directory when unset. */
  remoteDir?: string;
  /** Extra arguments inserted before the host, e.g. -J jumphost, -o ServerAliveInterval=30. */
  extraArgs?: string[];
}

/** A pane exactly as it appears in multitask.config.json; unset fields inherit defaults. */
export interface PaneConfig {
  id: string;
  title?: string;
  profile?: ProfileId;
  /** WSL distro name, only for profile 'wsl'. */
  distro?: string;
  /** Container settings, only for profile 'docker'. */
  docker?: DockerConfig;
  /** Remote host settings, only for profile 'ssh'. */
  ssh?: SshConfig;
  /** This pane's artifact folder, relative to the app root or absolute. */
  workspace?: string;
  /** Terminal colour theme id; see src/shared/themes.ts. Falls back to the default. */
  theme?: string;
  /** What to start in the pane; inferred as `command` when `command` is set. */
  launch?: LaunchMode;
  /** The command line for `launch: 'command'`, typed into the shell exactly as written. */
  command?: string;
  /** Text sent once the started program is ready. A prompt for Claude, stdin for anything else. */
  task?: string;
  model?: string;
  claudeArgs?: string[];
  claudeBin?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
  autoSubmit?: boolean;
  /** Reuse the previous conversation when this pane restarts. Defaults to true. */
  resume?: boolean;
  /** Wipe the terminal's screen and scrollback when the pane (re)starts. Defaults to false. */
  clearOnRestart?: boolean;
}

export interface ResolvedDocker extends DockerConfig {
  image: string;
  mode: 'run' | 'exec';
  containerName: string;
  workdir: string;
  shell: string[];
  claudeConfigMode: ClaudeConfigMode;
  claudeHome: string;
  extraArgs: string[];
}

/** A pane with every inheritable field already filled in from defaults. */
export interface ResolvedPane extends PaneConfig {
  title: string;
  profile: ProfileId;
  workspace: string;
  theme: string;
  launch: LaunchMode;
  command: string;
  task: string;
  claudeArgs: string[];
  env: Record<string, string>;
  autoStart: boolean;
  autoSubmit: boolean;
  resume: boolean;
  clearOnRestart: boolean;
  /** Session id from a previous run of this pane, when one is known. */
  resumeSessionId?: string;
  docker: ResolvedDocker;
  ssh: SshConfig;
}

export interface Defaults {
  profile: ProfileId;
  /** Theme for panes that do not set their own, and for the app chrome. */
  theme?: string;
  launch?: LaunchMode;
  /** Command for panes that run one but do not define their own. */
  command?: string;
  distro?: string;
  model?: string;
  claudeArgs: string[];
  claudeBin?: string;
  autoStart: boolean;
  autoSubmit: boolean;
  resume?: boolean;
  clearOnRestart?: boolean;
  /** Play a short sound when a pane starts waiting on you. Off by default. */
  sound?: boolean;
  fontSize: number;
  docker?: DockerConfig;
}

export interface AppConfig {
  version: 1;
  grid: { cols: number; rows: number };
  defaults: Defaults;
  panes: PaneConfig[];
  /** Colour schemes saved from the theme editor; reloaded on the next launch. */
  customThemes?: import('./themes.js').Theme[];
}

/**
 * What the pane's Claude session is doing, derived from its hook events rather than from
 * the terminal's text. `needs-you` is the one that matters: it means Claude has stopped
 * and is waiting on you.
 */
export type PaneActivity = 'unknown' | 'ready' | 'working' | 'needs-you' | 'ended';

/** A hook payload from Claude Code. Only the fields the app relies on are typed. */
export interface HookEvent {
  hook_event_name:
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'PreToolUse'
    | 'PostToolUse'
    | 'Notification'
    | 'Stop'
    | 'SessionEnd';
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  prompt?: string;
  message?: string;
  reason?: string;
}

/** A pane's live state, mirrored into the renderer. */
export interface PaneState {
  id: string;
  status: PaneStatus;
  pid?: number;
  exitCode?: number;
  message?: string;
  startedAt?: number;
  /** True once the task prompt has been written into the PTY. */
  promptSent: boolean;

  /** Hook-derived session state. */
  activity: PaneActivity;
  /** Why the pane wants you: a permission request, or Claude simply finished its turn. */
  needsReason?: 'permission' | 'turn-ended';
  /** Tool Claude is running right now, when it is working. */
  tool?: string;
  /** Claude's own session id, used to resume this pane's conversation on restart. */
  sessionId?: string;
  /** When the last hook event arrived. */
  lastEventAt?: number;
  /** Turns completed in this session, for a sense of progress. */
  turns: number;
  /** Token totals for the conversation, read from Claude's transcript. */
  usage?: PaneUsage;
}

/**
 * Tokens the pane's conversation has used so far, summed from the assistant messages in
 * Claude Code's transcript. Covers the main conversation; subagents keep their own files.
 */
export interface PaneUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * What these tokens would cost at Anthropic API list prices. Undefined when a model in
   * the conversation has no known price. Subscription plans are not billed per token.
   */
  costUsd?: number;
  /** Model of the most recent assistant message. */
  model?: string;
}

export interface Preflight {
  /** process.platform of the main process: 'win32', 'darwin' or 'linux'. */
  platform: string;
  claudeOnPath: string | null;
  pwshOnPath: string | null;
  wslDistros: string[];
  docker: DockerStatus;
  appRoot: string;
  configPath: string;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** A snapshot of machine load for the toolbar indicators. */
export interface ResourceSample {
  cpuPercent: number;
  memPercent: number;
  usedMemBytes: number;
  totalMemBytes: number;
  /** Memory attributable to this app across all its processes. */
  appMemBytes: number;
  cores: number;
  runningPanes: number;
  at: number;
}

export interface DockerImage {
  ref: string;
  id: string;
  size: string;
  created: string;
}

export interface DockerStatus {
  cliVersion: string | null;
  /** Null when the CLI is installed but the engine is not reachable. */
  serverVersion: string | null;
  error: string | null;
  images: DockerImage[];
  runningContainers: string[];
}

/**
 * Bases the bundled Dockerfile is known to work on. It installs git, ripgrep and, when
 * the base does not already ship it, Node 22 — so all of these end up equivalent.
 */
export const RECOMMENDED_BASES: { image: string; note: string }[] = [
  {
    image: 'node:22-bookworm-slim',
    note: 'Smallest sensible choice. Node 22 already present, Debian apt available. Start here.',
  },
  {
    image: 'mcr.microsoft.com/devcontainers/javascript-node:22',
    note: 'Heavier, but ships git, build tools and a non-root "node" user. Matches VS Code dev containers.',
  },
  {
    image: 'mcr.microsoft.com/devcontainers/python:3.12',
    note: 'For Python work. Node 22 is added on top by the Dockerfile.',
  },
  {
    image: 'ubuntu:24.04',
    note: 'Plain Ubuntu when you want to control the toolchain. Node 22 is added from NodeSource.',
  },
];
