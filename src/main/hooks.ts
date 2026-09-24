import { mkdir, writeFile, stat, open } from 'node:fs/promises';
import path from 'node:path';
import type { HookEvent, ResolvedPane } from '../shared/types.js';

/**
 * Claude Code can run a command on each lifecycle event and pipes a JSON payload to it on
 * stdin. Each pane points those hooks at a file in its own workspace and the app tails it,
 * which gives real state — "waiting for you", "running Bash", "finished" — instead of
 * scraping the TUI's output for phrases that change between releases.
 *
 * Verified payload fields: hook_event_name, session_id, transcript_path, cwd, plus
 * tool_name on PreToolUse/PostToolUse and prompt on UserPromptSubmit.
 */
const EVENTS: HookEvent['hook_event_name'][] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
];

export const HOOK_DIR = '.multitask';
export const EVENTS_FILE = 'events.ndjson';
export const SETTINGS_FILE = 'hooks.settings.json';

export function eventsPath(workspace: string): string {
  return path.join(workspace, HOOK_DIR, EVENTS_FILE);
}

export function settingsPath(workspace: string): string {
  return path.join(workspace, HOOK_DIR, SETTINGS_FILE);
}

/**
 * The shell that runs the hook is Claude's own, not the pane's, so the append command
 * follows the platform Claude is running on. `findstr "^"` matches every line, which makes
 * it a plain stdin-to-stdout filter on Windows; POSIX just uses cat.
 */
function appendCommand(pane: ResolvedPane, shellEventsPath: string): string {
  if (pane.profile === 'cmd' || pane.profile === 'powershell') {
    return `findstr "^" >> "${shellEventsPath}"`;
  }
  return `cat >> '${shellEventsPath}'`;
}

/**
 * Write the settings file the pane's `claude --settings` will load, and truncate the event
 * log so the tailer starts from a known offset.
 */
export async function prepareHooks(
  pane: ResolvedPane,
  workspace: string,
  shellEventsPath: string,
): Promise<void> {
  await mkdir(path.join(workspace, HOOK_DIR), { recursive: true });
  const command = appendCommand(pane, shellEventsPath);
  const hooks: Record<string, unknown[]> = {};
  for (const event of EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command }] }];
  }
  await writeFile(settingsPath(workspace), JSON.stringify({ hooks }, null, 2), 'utf8');
  await writeFile(eventsPath(workspace), '', 'utf8');
}

/**
 * Follow a pane's event file.
 *
 * Polling rather than fs.watch on purpose: a docker pane writes the file from inside the
 * container through a bind mount, and those writes do not reliably raise change events on
 * the host.
 */
export class EventTail {
  private offset = 0;
  private pending = '';
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(
    private readonly file: string,
    private readonly onEvent: (event: HookEvent) => void,
    private readonly intervalMs = 400,
  ) {}

  start(): void {
    this.stop();
    this.offset = 0;
    this.pending = '';
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const info = await stat(this.file).catch(() => null);
      if (!info) return;
      // A restart truncates the file; start over rather than read past the end.
      if (info.size < this.offset) {
        this.offset = 0;
        this.pending = '';
      }
      if (info.size === this.offset) return;

      const handle = await open(this.file, 'r');
      try {
        const length = info.size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = info.size;
        this.consume(buffer.toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch {
      /* the file may vanish with its workspace; the next poll picks it up again */
    } finally {
      this.reading = false;
    }
  }

  private consume(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    // The last piece may be a partial line still being written.
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as HookEvent;
        if (parsed.hook_event_name) this.onEvent(parsed);
      } catch {
        /* a half-flushed line, or something that is not ours */
      }
    }
  }
}
