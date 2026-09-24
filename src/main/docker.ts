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
      error: 'The docker command was not found on PATH. Install Docker Desktop for Windows.',
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
      error:
        'Docker is installed but its engine is not reachable. Start Docker Desktop and wait ' +
        'for the whale icon to stop animating, then press Refresh.',
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
        'No credentials were found to seed this pane\u2019s Claude home; Claude may ask you to log in inside the container.';
    }
    args.push('-v', `${toMountPath(paneHome)}:${d.claudeHome}`);
  }

  const paneJson = await preparePaneConfig(workspace, d.workdir);
  args.push('-v', `${toMountPath(paneJson)}:${containerHome}/.claude.json`);
  return { args, warning };
}
