import { z } from 'zod';
import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultProfileFor } from '../shared/types.js';
import { DEFAULT_CLAUDE_HOME } from './docker.js';
import type {
  AppConfig,
  DockerConfig,
  PaneConfig,
  ResolvedDocker,
  ResolvedPane,
} from '../shared/types.js';
import { DEFAULT_THEME_ID, PALETTE_KEYS, getTheme, setCustomThemes } from '../shared/themes.js';
import type { TerminalPalette } from '../shared/themes.js';

const profileId = z.enum(['cmd', 'powershell', 'wsl', 'docker', 'posix']);
const launchMode = z.enum(['claude', 'command', 'shell']);

// Built from PALETTE_KEYS so a new colour slot cannot be forgotten here. The cast just
// restores the concrete type that Object.fromEntries erases; every key is still checked.
const paletteSchema = z.object(
  Object.fromEntries(
    PALETTE_KEYS.map((key) => [key, z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
  ) as Record<string, z.ZodString>,
) as unknown as z.ZodType<TerminalPalette>;

/** A colour scheme the user saved; merged with the built-ins at load. */
const customThemeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  light: z.boolean().default(false),
  highContrast: z.boolean().optional(),
  note: z.string().default('Saved scheme.'),
  palette: paletteSchema,
});

const dockerSchema = z.object({
  image: z.string().optional(),
  mode: z.enum(['run', 'exec']).optional(),
  containerName: z.string().optional(),
  workdir: z.string().optional(),
  shell: z.array(z.string()).optional(),
  claudeConfigMode: z.enum(['shared', 'copy', 'none']).optional(),
  claudeHome: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  user: z.string().optional(),
});

const DOCKER_DEFAULTS = {
  image: 'claude-multitask:latest',
  mode: 'run' as const,
  workdir: '/work',
  shell: ['bash', '-l'],
  claudeConfigMode: 'shared' as const,
  claudeHome: DEFAULT_CLAUDE_HOME,
  extraArgs: [] as string[],
};

const paneSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, 'id may only contain letters, digits, dot, dash, underscore'),
  title: z.string().default(''),
  profile: profileId.optional(),
  // Not an enum: an unknown id should fall back, not invalidate the whole config.
  theme: z.string().optional(),
  launch: launchMode.optional(),
  command: z.string().optional(),
  distro: z.string().optional(),
  docker: dockerSchema.optional(),
  workspace: z.string().optional(),
  task: z.string().default(''),
  model: z.string().optional(),
  claudeArgs: z.array(z.string()).optional(),
  claudeBin: z.string().optional(),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().optional(),
  autoSubmit: z.boolean().optional(),
  resume: z.boolean().optional(),
});

const configSchema = z.object({
  version: z.literal(1).default(1),
  grid: z
    .object({ cols: z.number().int().min(1).max(6), rows: z.number().int().min(1).max(6) })
    .default({ cols: 2, rows: 2 }),
  defaults: z
    .object({
      profile: profileId.default(defaultProfileFor(process.platform)),
      theme: z.string().default(DEFAULT_THEME_ID),
      launch: launchMode.default('claude'),
      command: z.string().optional(),
      distro: z.string().optional(),
      model: z.string().optional(),
      claudeArgs: z.array(z.string()).default([]),
      claudeBin: z.string().optional(),
      autoStart: z.boolean().default(false),
      autoSubmit: z.boolean().default(true),
      resume: z.boolean().default(true),
      sound: z.boolean().default(false),
      fontSize: z.number().int().min(8).max(32).default(13),
      docker: dockerSchema.optional(),
    })
    .default({}),
  panes: z.array(paneSchema).default([]),
  customThemes: z.array(customThemeSchema).default([]),
});

/**
 * App root: the folder holding multitask.config.json and workspaces/.
 *
 * - Dev: the repo.
 * - Packaged on Windows: the folder next to the .exe, so the config and artifacts are
 *   reachable without digging into resources/. The portable build runs from a temporary
 *   unpack folder, so it uses the folder the portable .exe itself sits in.
 * - Packaged on macOS/Linux: the per-user data folder. A signed .app bundle and a mounted
 *   AppImage are both read-only, so nothing can live next to the executable.
 */
export function appRoot(): string {
  if (!app.isPackaged) return path.resolve(__dirname, '../..');
  if (process.platform !== 'win32') return app.getPath('userData');
  cachedWinRoot ??= windowsPackagedRoot();
  return cachedWinRoot;
}

let cachedWinRoot: string | undefined;

/**
 * Next to the .exe when that folder is usable, which is where the per-user installer and
 * the portable build put it. The installer also lets people choose Program Files, which a
 * normal user cannot write to, so then the config lives in the per-user data folder.
 */
function windowsPackagedRoot(): string {
  const beside = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  // An existing config wins: that is where this user already keeps their panes.
  if (existsSync(path.join(beside, 'multitask.config.json'))) return beside;
  const probe = path.join(beside, `.multitask-write-test-${process.pid}`);
  try {
    // Windows ACLs make access(W_OK) unreliable, so actually write.
    writeFileSync(probe, '');
    unlinkSync(probe);
    return beside;
  } catch {
    return app.getPath('userData');
  }
}

export function configPath(): string {
  return path.join(appRoot(), 'multitask.config.json');
}

export function defaultConfig(): AppConfig {
  return configSchema.parse({
    grid: { cols: 2, rows: 2 },
    panes: [1, 2, 3, 4].map((n) => ({
      id: `pane-${n}`,
      title: `Task ${n}`,
      task: '',
    })),
  }) as AppConfig;
}

/** Fill every pane field from defaults so the rest of the app never re-resolves them. */
export function resolvePanes(cfg: AppConfig): ResolvedPane[] {
  // Register first: a pane may name a scheme that only exists in this config.
  setCustomThemes(cfg.customThemes);
  const d = cfg.defaults;
  return cfg.panes.map((p) => ({
    ...p,
    title: p.title || p.id,
    profile: p.profile ?? d.profile,
    distro: p.distro ?? d.distro,
    workspace: p.workspace || defaultWorkspace(p.id),
    theme: getTheme(p.theme ?? d.theme).id,
    // A hand-written config that only sets `command` means `launch: 'command'`.
    launch: p.launch ?? ((p.command ?? d.command)?.trim() ? 'command' : d.launch ?? 'claude'),
    command: p.command ?? d.command ?? '',
    task: p.task ?? '',
    model: p.model ?? d.model,
    claudeArgs: p.claudeArgs ?? d.claudeArgs,
    claudeBin: p.claudeBin ?? d.claudeBin,
    autoStart: p.autoStart ?? d.autoStart,
    autoSubmit: p.autoSubmit ?? d.autoSubmit,
    resume: p.resume ?? d.resume ?? true,
    env: p.env ?? {},
    docker: resolveDocker(p, d.docker),
  }));
}

/** Docker settings resolve in three layers: pane, defaults, then built-in defaults. */
function resolveDocker(pane: PaneConfig, defaults: DockerConfig = {}): ResolvedDocker {
  const own = pane.docker ?? {};
  const pick = <K extends keyof DockerConfig>(key: K): DockerConfig[K] =>
    own[key] ?? defaults[key];
  return {
    image: pick('image') || DOCKER_DEFAULTS.image,
    mode: pick('mode') ?? DOCKER_DEFAULTS.mode,
    // A run container is named after the pane so a stale one can be found and removed.
    containerName: pick('containerName') || `mt-${pane.id.replace(/[^A-Za-z0-9_.-]/g, '-')}`,
    workdir: pick('workdir') || DOCKER_DEFAULTS.workdir,
    shell: pick('shell')?.length ? pick('shell')! : DOCKER_DEFAULTS.shell,
    claudeConfigMode: pick('claudeConfigMode') ?? DOCKER_DEFAULTS.claudeConfigMode,
    claudeHome: pick('claudeHome') || DOCKER_DEFAULTS.claudeHome,
    extraArgs: pick('extraArgs') ?? DOCKER_DEFAULTS.extraArgs,
    user: pick('user'),
  };
}

/** The folder a pane would use if it never set one: workspaces/<id>. */
export function defaultWorkspace(id: string): string {
  // Forward slashes so the value reads the same in the config however it was produced.
  return `workspaces/${id}`;
}

/**
 * Store a folder the way it reads best in the config: relative when it sits under the app
 * root, absolute when it is a project somewhere else on disk.
 */
export function toConfigWorkspace(absolute: string): string {
  const relative = path.relative(appRoot(), absolute);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return inside ? relative.split('\\').join('/') : absolute;
}

export function workspacePath(pane: ResolvedPane): string {
  return path.isAbsolute(pane.workspace)
    ? pane.workspace
    : path.resolve(appRoot(), pane.workspace);
}

export async function loadConfig(): Promise<{ config: AppConfig; error?: string }> {
  const file = configPath();
  if (!existsSync(file)) {
    const config = defaultConfig();
    await saveConfig(config);
    return { config };
  }
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = configSchema.parse(JSON.parse(raw));
    const ids = new Set<string>();
    for (const p of parsed.panes) {
      if (ids.has(p.id)) throw new Error(`duplicate pane id "${p.id}"`);
      ids.add(p.id);
    }
    return { config: parsed as AppConfig };
  } catch (err) {
    return { config: defaultConfig(), error: describeConfigError(err) };
  }
}

/** Turn a zod failure into something a person can act on, not a JSON dump. */
export function describeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message.toLowerCase()}`)
      .join('; ');
  }
  return (err as Error).message;
}

export async function saveConfig(config: AppConfig): Promise<void> {
  let validated: AppConfig;
  try {
    validated = configSchema.parse(config) as AppConfig;
  } catch (err) {
    throw new Error(`Those settings are not valid — ${describeConfigError(err)}`);
  }
  await mkdir(appRoot(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

export { configSchema };
