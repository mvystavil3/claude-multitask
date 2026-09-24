import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { ProfileId, ResolvedPane, SpawnSpec } from '../shared/types.js';
import {
  claudeMounts,
  containerExists,
  dockerStatus,
  imageExists,
  listRunningContainers,
  removeContainer,
  toMountPath,
} from './docker.js';

/** Argv assembled by the docker profile's prepare step, consumed by its buildSpawn. */
const dockerArgsCache = new Map<string, string[]>();
const dockerWarnings = new Map<string, string>();

export interface ShellProfile {
  id: ProfileId;
  label: string;
  /** False for profiles registered but not usable in this build. */
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

function which(exe: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const candidate = path.join(dir, exe + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findPwsh(): string | null {
  return which('pwsh') ?? which('powershell');
}

export function findClaude(): string | null {
  return which('claude');
}

export function listWslDistros(): Promise<string[]> {
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
  enabled: true,
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
    if (!exe) throw new Error('Neither pwsh.exe nor powershell.exe was found on PATH.');
    return {
      file: exe,
      args: ['-NoLogo', '-NoExit'],
      cwd: ws,
      env: baseEnv(pane.env),
    };
  },
  shellPath: (_pane, hostPath) => winPath(hostPath),
  claudeCommand: (pane, settings) => {
    const bin = pane.claudeBin ?? 'claude';
    const flags = claudeFlags(pane, settings).map(shellQuoteWin).join(' ');
    // The call operator lets PowerShell run a quoted executable path.
    const head = /\s/.test(bin) ? `& ${shellQuoteWin(bin)}` : bin;
    return `${head} ${flags}`.trim();
  },
};

const wslProfile: ShellProfile = {
  id: 'wsl',
  label: 'WSL (Ubuntu)',
  enabled: true,
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

    const mounts = await claudeMounts(pane, ws);
    if (mounts.warning) dockerWarnings.set(pane.id, mounts.warning);
    else dockerWarnings.delete(pane.id);

    const args = [
      'run',
      '-it',
      '--rm',
      '--name',
      d.containerName,
      '-v',
      `${toMountPath(ws)}:${d.workdir}`,
      '-w',
      d.workdir,
      ...mounts.args,
    ];
    if (d.user) args.push('--user', d.user);
    // `-e KEY` with no value forwards it from the docker CLI's own environment, which
    // keeps tokens out of the command line and out of `docker inspect`.
    for (const key of Object.keys(pane.env)) args.push('-e', key);
    if (d.claudeConfigMode === 'none' && process.env.ANTHROPIC_API_KEY) {
      args.push('-e', 'ANTHROPIC_API_KEY');
    }
    args.push(...d.extraArgs, d.image, ...d.shell);
    dockerArgsCache.set(pane.id, args);
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
};

export function getProfile(id: ProfileId): ShellProfile {
  const p = registry[id];
  if (!p) throw new Error(`Unknown shell profile "${id}".`);
  return p;
}

export const allProfiles = Object.values(registry);
