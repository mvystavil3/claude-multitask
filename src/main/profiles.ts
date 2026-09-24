import path from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { PROFILES, profileAvailable } from '../shared/types.js';
import type { ProfileId, ResolvedPane, SpawnSpec } from '../shared/types.js';
import {
  buildRunArgs,
  containerExists,
  dockerStatus,
  imageExists,
  listRunningContainers,
  removeContainer,
} from './docker.js';

/** Argv assembled by the docker profile's prepare step, consumed by its buildSpawn. */
const dockerArgsCache = new Map<string, string[]>();
const dockerWarnings = new Map<string, string>();

export interface ShellProfile {
  id: ProfileId;
  label: string;
  /** False when this shell does not exist on the current platform (cmd on macOS, say). */
  enabled: boolean;
  /**
   * Async work needed before the PTY exists — checking an image is present, clearing a
   * stale container, seeding a credentials mount. Throwing here fails the pane with the
   * thrown message, which is how docker reports a missing image or a stopped engine.
   */
  prepare?(pane: ResolvedPane, workspaceHostPath: string): Promise<void>;
  /** Non-fatal note raised by `prepare`, surfaced in the pane header. */
  warningFor?(pane: ResolvedPane): string | undefined;
  /**
   * Whether Claude in this shell can see the pane's folder on the host, which the hook
   * settings and event log live in. Assumed true when absent.
   */
  hooksReachable?(pane: ResolvedPane): boolean;
  /** Tear down anything `prepare` created, after the PTY is gone. */
  cleanup?(pane: ResolvedPane): Promise<void>;
  /** How the PTY process is started for a pane. */
  buildSpawn(pane: ResolvedPane, workspaceHostPath: string): SpawnSpec;
  /** Translate a host path into the path this shell sees. */
  shellPath(pane: ResolvedPane, hostPath: string, workspaceHostPath: string): string;
  /** Command line typed into the shell to start Claude Code. */
  claudeCommand(pane: ResolvedPane, settingsShellPath?: string): string;
  /** Line ending the shell expects on the PTY. */
  newline: string;
}

const isWindows = process.platform === 'win32';

function which(exe: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // Windows resolves a bare name only through PATHEXT; the extensionless `claude` that npm
  // writes next to claude.cmd is a POSIX script Windows cannot run. Elsewhere the file must
  // be executable, not merely exist.
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, exe + ext);
      if (isRunnable(candidate)) return candidate;
    }
  }
  return null;
}

function isRunnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (!isWindows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findPwsh(): string | null {
  return which('pwsh') ?? which('powershell');
}

export function findClaude(): string | null {
  return which('claude');
}

export function listWslDistros(): Promise<string[]> {
  if (!isWindows) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--list', '--quiet'],
      { encoding: 'buffer', windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        // wsl --list emits UTF-16LE.
        const text = (stdout as unknown as Buffer).toString('utf16le');
        resolve(
          text
            .split(/\r?\n/)
            .map((s) => s.replace(/\u0000/g, '').trim())
            .filter((s) => s.length > 0 && s !== 'docker-desktop' && s !== 'docker-desktop-data'),
        );
      },
    );
  });
}

/** D:\a\b becomes /mnt/d/a/b */
export function toWslPath(hostPath: string): string {
  const resolved = path.resolve(hostPath);
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(resolved);
  const slashed = (s: string) => s.split('\\').join('/');
  if (!drive) return slashed(resolved);
  const rest = slashed(drive[2]);
  return `/mnt/${drive[1].toLowerCase()}${rest ? '/' + rest : ''}`;
}

/** POSIX single-quote: close, escape, reopen. */
function shellQuotePosix(s: string): string {
  return "'" + s.split("'").join("'\\''") + "'";
}

/** Windows shells: wrap in double quotes only when the token needs it. */
function shellQuoteWin(s: string): string {
  return /[\s"^&|<>()]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
}

/**
 * PowerShell: single quotes are fully literal (no `$var`, no backtick escapes), so a path
 * like C:\Users\$ally\ or an argument with @ or { } survives. A ' is doubled.
 */
function shellQuotePwsh(s: string): string {
  return /^[A-Za-z0-9_\-./:\\=]+$/.test(s) ? s : "'" + s.split("'").join("''") + "'";
}

/**
 * npm installs Claude Code as claude.ps1 next to claude.cmd, and PowerShell prefers the
 * .ps1 — which the default execution policy (Restricted / RemoteSigned on a fresh
 * Windows) refuses to run. Name the .cmd explicitly when that is what PATH resolves to;
 * the native installer's claude.exe, and every non-Windows install, stays plain `claude`.
 */
function powershellClaudeBin(): string {
  if (!isWindows) return 'claude';
  const found = findClaude();
  return found && /\.cmd$/i.test(found) ? 'claude.cmd' : 'claude';
}

/**
 * Variables Claude Code sets for a nested session. Each pane must look like a fresh
 * top-level session, otherwise transcripts are disabled and hooks misbehave.
 */
const NESTED_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT'];

/** The base environment a pane's shell inherits. */
function baseEnv(paneEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !NESTED_MARKERS.includes(key)) env[key] = value;
  }
  return { ...env, ...paneEnv };
}

const winPath = (p: string) => path.resolve(p);
const posixSlashes = (p: string) => p.split('\\').join('/');

function claudeFlags(pane: ResolvedPane, settingsShellPath?: string): string[] {
  const args: string[] = [];
  if (pane.model) args.push('--model', pane.model);
  // The app's own hook settings, unless the pane already points at a settings file.
  const ownSettings = pane.claudeArgs?.some((a) => a.startsWith('--settings'));
  if (settingsShellPath && !ownSettings) args.push('--settings', settingsShellPath);
  // Resuming keeps the pane's conversation across a restart.
  if (pane.resume && pane.resumeSessionId) args.push('--resume', pane.resumeSessionId);
  if (pane.claudeArgs?.length) args.push(...pane.claudeArgs);
  return args;
}

const cmdProfile: ShellProfile = {
  id: 'cmd',
  label: 'Windows cmd',
  enabled: isWindows,
  newline: '\r',
  buildSpawn: (pane, ws) => ({
    file: process.env.COMSPEC ?? 'cmd.exe',
    args: [],
    cwd: ws,
    env: baseEnv(pane.env),
  }),
  shellPath: (_pane, hostPath) => winPath(hostPath),
  claudeCommand: (pane, settings) =>
    [pane.claudeBin ?? 'claude', ...claudeFlags(pane, settings)].map(shellQuoteWin).join(' '),
};

const powershellProfile: ShellProfile = {
  id: 'powershell',
  label: 'PowerShell',
  enabled: true,
  newline: '\r',
  buildSpawn: (pane, ws) => {
    const exe = findPwsh();
    if (!exe) {
      throw new Error(
        isWindows
          ? 'Neither pwsh.exe nor powershell.exe was found on PATH.'
          : 'pwsh was not found on PATH. Install PowerShell, or use the login shell profile.',
      );
    }
    return {
      file: exe,
      args: ['-NoLogo', '-NoExit'],
      cwd: ws,
      env: baseEnv(pane.env),
    };
  },
  shellPath: (_pane, hostPath) => winPath(hostPath),
  claudeCommand: (pane, settings) => {
    const bin = pane.claudeBin ?? powershellClaudeBin();
    const flags = claudeFlags(pane, settings).map(shellQuotePwsh).join(' ');
    // The call operator runs a quoted path; it is harmless on a bare name too.
    return `& ${shellQuotePwsh(bin)} ${flags}`.trim();
  },
};

const wslProfile: ShellProfile = {
  id: 'wsl',
  label: 'WSL',
  enabled: isWindows,
  newline: '\r',
  buildSpawn: (pane, ws) => {
    const args = ['--cd', toWslPath(ws)];
    if (pane.distro) args.unshift('-d', pane.distro);
    const paneEnv = pane.env;
    return {
      file: 'wsl.exe',
      args,
      cwd: ws,
      env: {
        ...baseEnv(paneEnv),
        // WSLENV forwards just the pane's own variables into the distro.
        WSLENV: [process.env.WSLENV, ...Object.keys(paneEnv)].filter(Boolean).join(':'),
      },
    };
  },
  shellPath: (_pane, hostPath) => toWslPath(hostPath),
  claudeCommand: (pane, settings) =>
    [pane.claudeBin ?? 'claude', ...claudeFlags(pane, settings)].map(shellQuotePosix).join(' '),
};

/**
 * The user's own shell on macOS and Linux: $SHELL as a login shell, so PATH additions
 * from .zprofile / .bash_profile (where npm's global bin usually lands) are in effect and
 * `claude` is found the same way it is in a normal terminal.
 */
const posixProfile: ShellProfile = {
  id: 'posix',
  label: 'Login shell ($SHELL)',
  enabled: !isWindows,
  newline: '\r',
  buildSpawn: (pane, ws) => ({
    file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: ['-l'],
    cwd: ws,
    env: { ...baseEnv(pane.env), COLORTERM: 'truecolor' },
  }),
  shellPath: (_pane, hostPath) => path.resolve(hostPath),
  claudeCommand: (pane, settings) =>
    [pane.claudeBin ?? 'claude', ...claudeFlags(pane, settings)].map(shellQuotePosix).join(' '),
};

/**
 * Runs the pane inside a container. `run` starts a throwaway container with the pane's
 * folder bind-mounted; `exec` attaches to a container the user already has running.
 *
 * The mount flags built here are deliberately computed in `prepare`, not in `buildSpawn`,
 * because seeding a per-pane Claude home touches the filesystem.
 */
const dockerProfile: ShellProfile = {
  id: 'docker',
  label: 'Docker container',
  enabled: true,
  newline: '\r',
  prepare: async (pane, ws) => {
    const d = pane.docker;
    const status = await dockerStatus();
    if (status.error) throw new Error(status.error);

    if (d.mode === 'exec') {
      if (!d.containerName) throw new Error('Set a container name for a docker exec pane.');
      if (!(await listRunningContainers()).includes(d.containerName)) {
        throw new Error(
          `No running container named "${d.containerName}". Start it, or switch this pane to run mode.`,
        );
      }
      // An existing container cannot gain new bind mounts, so its own Claude Code must
      // already be set up. The one thing exec can still pass in is an API key.
      const execArgs = ['exec', '-it', '-w', d.workdir];
      for (const key of Object.keys(pane.env)) execArgs.push('-e', key);
      if (process.env.ANTHROPIC_API_KEY) execArgs.push('-e', 'ANTHROPIC_API_KEY');
      execArgs.push(d.containerName, ...d.shell);
      dockerArgsCache.set(pane.id, execArgs);
      dockerWarnings.set(
        pane.id,
        'Exec panes use the container’s own Claude Code install and credentials, and ' +
          'report no activity state: mounts cannot be added to a running container.',
      );
      return;
    }

    if (!(await imageExists(d.image))) {
      throw new Error(
        `The image "${d.image}" is not present locally. Build or pull it from ` +
          'Settings → Docker images, then restart this pane.',
      );
    }
    // A hard kill can leave the previous container behind and its name is taken.
    if (await containerExists(d.containerName)) await removeContainer(d.containerName);

    const run = await buildRunArgs(pane, ws);
    if (run.warning) dockerWarnings.set(pane.id, run.warning);
    else dockerWarnings.delete(pane.id);
    dockerArgsCache.set(pane.id, run.args);
  },
  buildSpawn: (pane, ws) => {
    const args = dockerArgsCache.get(pane.id);
    if (!args) throw new Error('Docker pane was not prepared; restart it.');
    return { file: 'docker', args, cwd: ws, env: baseEnv(pane.env) };
  },
  warningFor: (pane) => dockerWarnings.get(pane.id),
  // An exec container never had the pane folder mounted, so the settings file and event
  // log are not there; pointing --settings at them would stop Claude from starting.
  hooksReachable: (pane) => pane.docker.mode !== 'exec',
  cleanup: async (pane) => {
    dockerArgsCache.delete(pane.id);
    // --rm covers a clean exit; this catches a container left behind by a hard kill.
    if (pane.docker.mode === 'run') await removeContainer(pane.docker.containerName);
  },
  // The workspace is bind-mounted at workdir, so a host path under it maps straight across.
  shellPath: (pane, hostPath, workspace) => {
    const relative = posixSlashes(path.relative(workspace, hostPath));
    return `${pane.docker.workdir}/${relative}`;
  },
  claudeCommand: (pane, settings) =>
    [pane.claudeBin ?? 'claude', ...claudeFlags(pane, settings)].map(shellQuotePosix).join(' '),
};

const registry: Record<ProfileId, ShellProfile> = {
  cmd: cmdProfile,
  powershell: powershellProfile,
  wsl: wslProfile,
  docker: dockerProfile,
  posix: posixProfile,
};

export function getProfile(id: ProfileId): ShellProfile {
  const p = registry[id];
  if (!p) throw new Error(`Unknown shell profile "${id}".`);
  return p;
}

/** Why a pane's shell cannot run on this machine, or null when it can. */
export function unavailableReason(id: ProfileId): string | null {
  if (profileAvailable(id, process.platform)) return null;
  const label = PROFILES.find((p) => p.id === id)?.label ?? id;
  return (
    `The "${label}" shell does not exist on this platform (${process.platform}). ` +
    'Pick another shell for this pane in Settings.'
  );
}
