import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DockerImage, DockerStatus, ResolvedPane } from '../shared/types.js';

const EXEC_TIMEOUT_MS = 15_000;

function run(args: string[], timeout = EXEC_TIMEOUT_MS): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: ((err ? stderr : stdout) || '').toString().trim() });
      },
    );
  });
}

/**
 * Where the bundled Dockerfile lives. Injected by main at startup rather than derived
 * from electron here, so this module stays usable outside an Electron process.
 */
let dockerfileDirOverride: string | null = null;

export function setDockerfileDir(dir: string): void {
  dockerfileDirOverride = dir;
}

export function dockerfileDir(): string {
  return dockerfileDirOverride ?? path.resolve(__dirname, '../../build/docker');
}

export async function dockerStatus(): Promise<DockerStatus> {
  const cli = await run(['--version']);
  if (!cli.ok) {
    return {
      cliVersion: null,
      serverVersion: null,
      error:
        'The docker command was not found on PATH. ' +
        (process.platform === 'linux'
          ? 'Install Docker Engine (or Docker Desktop for Linux).'
          : `Install Docker Desktop for ${process.platform === 'darwin' ? 'Mac' : 'Windows'}.`),
      images: [],
      runningContainers: [],
    };
  }
  const cliVersion = cli.out.replace(/^Docker version\s*/i, '');

  const server = await run(['version', '--format', '{{.Server.Version}}']);
  if (!server.ok || !server.out) {
    return {
      cliVersion,
      serverVersion: null,
      error: engineUnreachable(server.out),
      images: [],
      runningContainers: [],
    };
  }

  const [images, containers] = await Promise.all([listImages(), listRunningContainers()]);
  return {
    cliVersion,
    serverVersion: server.out,
    error: null,
    images,
    runningContainers: containers,
  };
}

/** What to tell someone whose engine did not answer, from the CLI's own complaint. */
function engineUnreachable(detail: string): string {
  // Linux without Docker Desktop: the daemon is up but this user is not in the docker group.
  if (/permission denied/i.test(detail)) {
    return (
      'Your user cannot reach the Docker daemon (permission denied). Add it to the docker ' +
      'group with "sudo usermod -aG docker $USER", log out and back in, then press Refresh.'
    );
  }
  if (process.platform === 'linux') {
    return (
      'Docker is installed but its engine is not reachable. Start it with ' +
      '"sudo systemctl start docker" (or start Docker Desktop), then press Refresh.'
    );
  }
  return (
    'Docker is installed but its engine is not reachable. Start Docker Desktop and wait ' +
    'for the whale icon to stop animating, then press Refresh.'
  );
}

export async function listImages(): Promise<DockerImage[]> {
  // Tab-separated rather than --format json: no shell quoting to get wrong on Windows.
  const res = await run([
    'image',
    'ls',
    '--filter',
    'dangling=false',
    '--format',
    '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}',
  ]);
  if (!res.ok) return [];
  return res.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [ref, id, size, created] = line.split('\t');
      return { ref, id, size: size ?? '', created: created ?? '' };
    })
    .filter((i) => i.ref && !i.ref.startsWith('<none>'));
}

export async function listRunningContainers(): Promise<string[]> {
  const res = await run(['ps', '--format', '{{.Names}}']);
  if (!res.ok) return [];
  return res.out.split(/\r?\n/).filter(Boolean);
}

export async function imageExists(ref: string): Promise<boolean> {
  return (await run(['image', 'inspect', ref])).ok;
}

export async function containerExists(name: string): Promise<boolean> {
  const res = await run(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
  return res.ok && res.out.split(/\r?\n/).includes(name);
}

export async function removeContainer(name: string): Promise<void> {
  await run(['rm', '-f', name], 30_000);
}

/** Long-running docker command with its output streamed line by line to `onLine`. */
export function stream(
  args: string[],
  onLine: (line: string) => void,
): Promise<{ ok: boolean; code: number }> {
  return new Promise((resolve) => {
    onLine(`$ docker ${args.join(' ')}`);
    const child = spawn('docker', args, { windowsHide: true });
    let pending = '';
    const emit = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (err) => {
      onLine(`failed to start docker: ${err.message}`);
      resolve({ ok: false, code: -1 });
    });
    child.on('close', (code) => {
      if (pending.trim()) onLine(pending);
      onLine(code === 0 ? 'done.' : `exited with code ${code}`);
      resolve({ ok: code === 0, code: code ?? -1 });
    });
  });
}

export function pullImage(ref: string, onLine: (line: string) => void) {
  return stream(['pull', ref], onLine);
}

export function loadImage(tarPath: string, onLine: (line: string) => void) {
  return stream(['load', '-i', tarPath], onLine);
}

/**
 * Build the bundled Dockerfile, which layers Claude Code (plus git and ripgrep, and Node
 * when the base lacks it) onto any Debian or Ubuntu based image.
 */
export function buildImage(
  tag: string,
  baseImage: string,
  onLine: (line: string) => void,
) {
  const dir = dockerfileDir();
  if (!existsSync(path.join(dir, 'Dockerfile'))) {
    onLine(`Dockerfile not found in ${dir}`);
    return Promise.resolve({ ok: false, code: -1 });
  }
  return stream(
    ['build', '-f', path.join(dir, 'Dockerfile'), '--build-arg', `BASE_IMAGE=${baseImage}`, '-t', tag, dir],
    onLine,
  );
}

/** Host paths Docker Desktop accepts in a -v flag: backslashes are not welcome. */
export function toMountPath(hostPath: string): string {
  return path.resolve(hostPath).split('\\').join('/');
}

/**
 * Claude Code on macOS keeps its login in the Keychain rather than in
 * ~/.claude/.credentials.json, and a container cannot read the Keychain.
 */
const MAC_KEYCHAIN_NOTE =
  'On macOS, Claude Code keeps its login in the Keychain, which a container cannot read. ' +
  'Use credentials mode "none" with ANTHROPIC_API_KEY set, or log in inside the container.';

export interface ClaudeMounts {
  args: string[];
  warning?: string;
}

/**
 * Prepare the pane's own .claude.json and return its host path.
 *
 * Every docker pane gets its own copy, seeded from the host's, in both `shared` and `copy`
 * mode. Two reasons: the host's config is never written to by a container, and the mount
 * point inside the container is a path the host has never heard of, so the trust dialog
 * has to be pre-accepted for it or the pane stalls on "Is this a project you trust?".
 */
async function preparePaneConfig(workspace: string, workdir: string): Promise<string> {
  const paneJson = path.join(workspace, '.multitask', 'claude.json');
  const hostJson = path.join(os.homedir(), '.claude.json');

  let config: Record<string, unknown> = {};
  const source = existsSync(paneJson) ? paneJson : existsSync(hostJson) ? hostJson : null;
  if (source) {
    try {
      config = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  config.hasCompletedOnboarding = true;

  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[workdir] = { ...(projects[workdir] ?? {}), hasTrustDialogAccepted: true };
  config.projects = projects;

  await mkdir(path.dirname(paneJson), { recursive: true });
  await writeFile(paneJson, JSON.stringify(config, null, 2), 'utf8');
  return paneJson;
}

/**
 * Build the -v flags that give a container access to Claude's credentials.
 *
 * `shared` bind-mounts the host's own ~/.claude directory, which is why it just works:
 * the credentials are already there. It also means the container can read the host's
 * OAuth token.
 *
 * `copy` gives the pane its own Claude home inside its workspace, seeded once from the
 * host's credentials, so nothing the container does can reach the host's.
 */
export async function claudeMounts(pane: ResolvedPane, workspace: string): Promise<ClaudeMounts> {
  const d = pane.docker;
  if (d.claudeConfigMode === 'none') {
    return {
      args: [],
      warning: process.env.ANTHROPIC_API_KEY
        ? undefined
        : 'Claude config mode is "none" and ANTHROPIC_API_KEY is not set, so Claude in the container has no credentials.',
    };
  }

  const hostClaudeDir = path.join(os.homedir(), '.claude');
  // claudeHome is e.g. /root/.claude, so the container's home is its parent.
  const containerHome = path.posix.dirname(d.claudeHome);
  const args: string[] = [];
  let warning: string | undefined;

  if (d.claudeConfigMode === 'shared') {
    if (!existsSync(hostClaudeDir)) {
      return { args: [], warning: `No Claude config found at ${hostClaudeDir}.` };
    }
    args.push('-v', `${toMountPath(hostClaudeDir)}:${d.claudeHome}`);
    if (process.platform === 'darwin' && !existsSync(path.join(hostClaudeDir, '.credentials.json'))) {
      warning = MAC_KEYCHAIN_NOTE;
    }
  } else {
    const paneHome = path.join(workspace, '.multitask', 'claude-home');
    await mkdir(paneHome, { recursive: true });
    for (const name of ['.credentials.json', 'settings.json']) {
      const src = path.join(hostClaudeDir, name);
      const dest = path.join(paneHome, name);
      if (existsSync(src) && !existsSync(dest)) await copyFile(src, dest).catch(() => {});
    }
    if (!existsSync(path.join(paneHome, '.credentials.json'))) {
      warning =
        process.platform === 'darwin'
          ? MAC_KEYCHAIN_NOTE
          : 'No credentials were found to seed this pane\u2019s Claude home; Claude may ask you to log in inside the container.';
    }
    args.push('-v', `${toMountPath(paneHome)}:${d.claudeHome}`);
  }

  const paneJson = await preparePaneConfig(workspace, d.workdir);
  args.push('-v', `${toMountPath(paneJson)}:${containerHome}/.claude.json`);
  return { args, warning };
}

/**
 * Map a path inside a container back to the host through the `-v host:container` flags in
 * its argv; null when no bind mount covers it. The longest matching mount point wins, so a
 * file mounted inside a mounted folder resolves to the file.
 */
export function toHostPath(args: string[], containerPath: string): string | null {
  let best: { host: string; point: string } | null = null;
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-v' && args[i] !== '--volume') continue;
    // host:container[:options]; the host side may itself hold a drive colon (C:/Users/…).
    const m = /^(.+?):(\/[^:]*)(?::[\w,]+)?$/.exec(args[i + 1]);
    if (!m) continue;
    const [, host, point] = m;
    const inside = containerPath === point || containerPath.startsWith(point.replace(/\/$/, '') + '/');
    if (inside && (!best || point.length > best.point.length)) best = { host, point };
  }
  if (!best) return null;
  const rest = containerPath.slice(best.point.replace(/\/$/, '').length).replace(/^\//, '');
  return rest ? path.join(best.host, ...rest.split('/')) : path.normalize(best.host);
}

/** Claude's home inside the container when nothing else is configured. */
export const DEFAULT_CLAUDE_HOME = '/root/.claude';
/** The home a container gets when it runs as the host user; see hostUser. */
const MAPPED_HOME = '/home/multitask';

/**
 * The uid:gid to run a Linux container as, or null to leave the image's own user.
 *
 * On Linux a bind mount has no ownership translation: whatever the container writes into
 * the pane's folder, or into a shared ~/.claude, belongs to the uid it ran as — root by
 * default — and the user then cannot edit or delete their own project files without sudo.
 * Docker Desktop on macOS and Windows translates ownership itself, so this is Linux only.
 * A pane that sets its own user (including "root" or "0") opts out.
 */
function hostUser(pane: ResolvedPane): string | null {
  if (process.platform !== 'linux' || pane.docker.user) return null;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) return null;
  return `${uid}:${gid}`;
}

/**
 * The full `docker run` argv for a pane in run mode, plus any warning to show on it. The
 * single place this is assembled; scripts/docker-argv.ts prints it for inspection.
 */
export async function buildRunArgs(
  pane: ResolvedPane,
  workspace: string,
): Promise<{ args: string[]; warning?: string }> {
  let d = pane.docker;
  const extra: string[] = [];

  const user = hostUser(pane);
  if (user) {
    // /root is mode 700, so a non-root uid could not even reach mounts placed under it.
    const claudeHome =
      d.claudeHome === DEFAULT_CLAUDE_HOME ? `${MAPPED_HOME}/.claude` : d.claudeHome;
    const home = path.posix.dirname(claudeHome);
    // A per-pane home owned by the host user, so whatever Claude writes outside ~/.claude
    // also lands somewhere writable. Mount points inside it are created here first,
    // because the daemon would otherwise create them on the host as root.
    const hostHome = path.join(workspace, '.multitask', 'home');
    await mkdir(path.join(hostHome, path.posix.basename(claudeHome)), { recursive: true });
    const jsonPoint = path.join(hostHome, '.claude.json');
    if (!existsSync(jsonPoint)) await writeFile(jsonPoint, '{}', 'utf8');
    d = { ...d, user, claudeHome };
    extra.push('-v', `${toMountPath(hostHome)}:${home}`, '-e', `HOME=${home}`);
  }

  const mounts = await claudeMounts({ ...pane, docker: d }, workspace);
  const args = [
    'run',
    '-it',
    '--rm',
    '--name',
    d.containerName,
    '-v',
    `${toMountPath(workspace)}:${d.workdir}`,
    '-w',
    d.workdir,
    ...extra,
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
  return { args, warning: mounts.warning };
}
