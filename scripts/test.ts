/**
 * Automated checks that run on every supported OS: `npm test`.
 *
 * Unit tests cover the logic that differs per platform and per user (quoting, path
 * translation, docker argv, hook commands). The session tests start real PTYs with the
 * platform's default shell, so they catch what only shows up on a real machine: prompt
 * detection, a missing `claude` reported in any language, and a clean stop. None of them
 * need Claude Code, Docker or network access, and all of them work in a temp folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/main/session.js';
import { buildSshArgs, getProfile, toWslPath, unavailableReason } from '../src/main/profiles.js';
import { prepareHooks, settingsPath } from '../src/main/hooks.js';
import { buildRunArgs, toHostPath } from '../src/main/docker.js';
import { TranscriptUsage, messageCost } from '../src/main/usage.js';
import {
  defaultProfileFor,
  profileAvailable,
  type PaneState,
  type ResolvedPane,
} from '../src/shared/types.js';

const isWindows = process.platform === 'win32';
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'multitask-test-'));

function pane(overrides: Partial<ResolvedPane> = {}): ResolvedPane {
  return {
    id: 'test',
    title: 'test',
    profile: defaultProfileFor(process.platform),
    workspace: tempDir(),
    theme: 'everforest-dark',
    launch: 'claude',
    command: '',
    task: '',
    claudeArgs: [],
    env: {},
    autoStart: false,
    autoSubmit: false,
    resume: true,
    clearOnRestart: false,
    ssh: {},
    docker: {
      image: 'claude-multitask:latest',
      mode: 'run',
      containerName: 'mt-test',
      workdir: '/work',
      shell: ['bash', '-l'],
      claudeConfigMode: 'none',
      claudeHome: '/root/.claude',
      extraArgs: [],
    },
    ...overrides,
  };
}

// ---------- platforms ----------

test('the default shell exists on this platform', () => {
  const id = defaultProfileFor(process.platform);
  assert.ok(profileAvailable(id, process.platform));
  assert.equal(unavailableReason(id), null);
});

test('shells from another OS are refused with a message, not spawned', () => {
  const foreign = isWindows ? 'posix' : 'cmd';
  assert.match(unavailableReason(foreign) ?? '', /does not exist on this platform/);
});

// ---------- quoting ----------

test('cmd quotes paths with spaces', () => {
  const line = getProfile('cmd').claudeCommand(pane(), 'C:\\Users\\Ann Lee\\x\\hooks.json');
  assert.ok(line.includes('"C:\\Users\\Ann Lee\\x\\hooks.json"'), line);
});

test('PowerShell keeps $, spaces and quotes literal', () => {
  const line = getProfile('powershell').claudeCommand(
    pane({ model: "o'brien" }),
    'C:\\Users\\$ally smith\\hooks.json',
  );
  assert.ok(line.startsWith('& '), line);
  assert.ok(line.includes("'C:\\Users\\$ally smith\\hooks.json'"), line);
  assert.ok(line.includes("'o''brien'"), line);
});

test('POSIX shells escape single quotes', () => {
  const line = getProfile('docker').claudeCommand(pane({ model: "it's" }), '/work/.multitask/h.json');
  assert.ok(line.includes("'it'\\''s'"), line);
});

test('the pane settings file is passed unless the pane brings its own', () => {
  const own = getProfile('docker').claudeCommand(pane({ claudeArgs: ['--settings', 'x.json'] }), '/s.json');
  assert.ok(!own.includes('/s.json'), own);
  const resumed = getProfile('docker').claudeCommand(pane({ resumeSessionId: 'abc' }), '/s.json');
  assert.match(resumed, /'--resume' 'abc'/);
});

test('WSL paths translate drive letters', { skip: !isWindows }, () => {
  assert.equal(toWslPath('D:\\work\\my project'), '/mnt/d/work/my project');
  assert.equal(toWslPath('C:\\'), '/mnt/c');
});

// ---------- hooks ----------

test('hook command matches the shell Claude runs in', async () => {
  const ws = tempDir();
  const read = () => readFileSync(settingsPath(ws), 'utf8');

  await prepareHooks(pane({ profile: 'docker' }), ws, "/work/it's/events.ndjson");
  assert.ok(read().includes("cat >> '/work/it'\\\\''s/events.ndjson'"), read());

  await prepareHooks(pane({ profile: 'powershell' }), ws, 'C:\\x\\events.ndjson');
  assert.ok(read().includes(isWindows ? 'findstr' : 'cat >>'), read());
});

// ---------- docker argv ----------

test('docker env values never reach the command line', async () => {
  const p = pane({ profile: 'docker', env: { SECRET_TOKEN: 'hunter2' } });
  const { args } = await buildRunArgs(p, p.workspace);
  assert.ok(args.includes('SECRET_TOKEN'));
  assert.ok(!args.join(' ').includes('hunter2'));
  assert.ok(args.includes('/work'));
});

test('Linux containers run as the host user unless a user is set', async () => {
  const p = pane({ profile: 'docker' });
  const { args } = await buildRunArgs(p, p.workspace);
  const mapped = process.platform === 'linux' && process.getuid?.() !== 0;
  assert.equal(args.includes('--user'), mapped, args.join(' '));

  const explicit = pane({ profile: 'docker' });
  explicit.docker = { ...explicit.docker, user: 'root' };
  const own = await buildRunArgs(explicit, explicit.workspace);
  assert.equal(own.args[own.args.indexOf('--user') + 1], 'root');
});

test('container paths map back to the host through the -v flags', () => {
  const args = ['run', '-v', 'C:/Users/Ann Lee/.claude:/root/.claude', '-v', '/srv/p:/work:ro'];
  assert.equal(
    toHostPath(args, '/root/.claude/projects/-work/abc.jsonl'),
    path.join('C:/Users/Ann Lee/.claude', 'projects', '-work', 'abc.jsonl'),
  );
  assert.equal(toHostPath(args, '/work'), path.normalize('/srv/p'));
  assert.equal(toHostPath(args, '/workspace/x'), null);
  assert.equal(toHostPath(args, '/tmp/x'), null);
});

// ---------- ssh ----------

test('ssh argv keeps the host after --, and quotes the remote command', () => {
  const p = pane({
    profile: 'ssh',
    env: { NOTE: "it's" },
    ssh: { host: 'ann@box', port: 2222, remoteDir: '/srv/my project', extraArgs: ['-J', 'jump'] },
  });
  const args = buildSshArgs(p);
  assert.deepEqual(args.slice(0, 7), ['-t', '-p', '2222', '-J', 'jump', '--', 'ann@box']);
  assert.equal(
    args[7],
    `cd '/srv/my project' && exec env 'NOTE=it'\\''s' "$SHELL" -l`,
  );
  assert.deepEqual(buildSshArgs(pane({ profile: 'ssh', ssh: { host: 'box' } })), ['-t', '--', 'box']);
});

test('ssh refuses a missing or option-like host', () => {
  assert.throws(() => buildSshArgs(pane({ profile: 'ssh' })), /host/);
  assert.throws(() => buildSshArgs(pane({ profile: 'ssh', ssh: { host: '-oProxyCommand=x' } })));
});

// ---------- usage ----------

const line = (id: string, model: string, usage: object) =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage } }) + '\n';

test('transcript usage counts each message once, using its latest line', () => {
  const t = new TranscriptUsage();
  const u1 = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1000 };
  t.consume(line('m1', 'claude-opus-5', u1));
  t.consume(line('m1', 'claude-opus-5', { ...u1, output_tokens: 200 }));
  t.consume(JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  t.consume(line('m2', 'claude-opus-5', { input_tokens: 5, output_tokens: 50 }).slice(0, 20));
  const partial = t.totals()!;
  assert.equal(partial.outputTokens, 200);
  assert.equal(partial.inputTokens, 10);
  // 10*5 + 200*25 + 1000*0.5 per million
  assert.ok(Math.abs(partial.costUsd! - 5550 / 1e6) < 1e-12, String(partial.costUsd));
});

test('usage has no cost when a model has no known price', () => {
  const t = new TranscriptUsage();
  t.consume(line('m1', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }));
  t.consume(line('m2', 'some-other-model', { input_tokens: 1, output_tokens: 1 }));
  assert.equal(t.totals()!.costUsd, undefined);
  assert.equal(t.totals()!.inputTokens, 2);
  // Model ids: a later opus must not be priced as opus-5, and 1h cache writes cost 2x.
  assert.equal(messageCost('claude-opus-5-5', { output_tokens: 1e6 }), 20);
  assert.equal(
    messageCost('claude-haiku-4-5', {
      cache_creation_input_tokens: 2e6,
      cache_creation: { ephemeral_1h_input_tokens: 1e6 },
    }),
    1.25 + 2,
  );
});

test('usage reads a transcript file incrementally', async () => {
  const dir = tempDir();
  const file = path.join(dir, 't.jsonl');
  const { appendFileSync, writeFileSync } = await import('node:fs');
  writeFileSync(file, line('a', 'claude-haiku-4-5', { input_tokens: 3, output_tokens: 4 }));
  const t = new TranscriptUsage();
  t.follow(file);
  assert.equal((await t.read())!.outputTokens, 4);
  appendFileSync(file, line('b', 'claude-haiku-4-5', { input_tokens: 3, output_tokens: 6 }));
  assert.equal((await t.read())!.outputTokens, 10);
});

// ---------- real sessions ----------

/** Start a session and resolve with the first state that satisfies `until`. */
function runUntil(
  p: ResolvedPane,
  until: (s: PaneState) => boolean,
  timeoutMs = 60_000,
): Promise<{ state: PaneState; output: string; session: Session }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let session: Session;
    const timer = setTimeout(() => {
      void session.dispose();
      reject(new Error(`timed out; output was:\n${output}`));
    }, timeoutMs);
    session = new Session(
      p,
      p.workspace,
      {
        onData: (_id, chunk) => (output += chunk),
        onState: (state) => {
          if (!until(state)) return;
          clearTimeout(timer);
          resolve({ state, output, session });
        },
      },
      { cols: 120, rows: 30 },
    );
    void session.start();
  });
}

test('a command runs in the default shell after its prompt', async () => {
  const p = pane({ launch: 'command', command: 'echo multitask-ok' });
  const { state, session } = await runUntil(
    p,
    (s) => s.status === 'running' || s.status === 'error',
  );
  assert.equal(state.status, 'running', state.message);
  await session.dispose();
});

test('a missing claude is reported instead of hanging', async () => {
  const p = pane({ claudeBin: 'definitely-not-claude-xyz' });
  const { state, session } = await runUntil(p, (s) => s.status === 'error');
  assert.match(state.message ?? '', /could not run/);
  await session.dispose();
});

test('a command that just returns to the prompt counts as failed, in any language', async () => {
  // `hostname` exists everywhere and exits at once, printing nothing any pattern knows.
  const p = pane({ claudeBin: 'hostname' });
  const { state, session } = await runUntil(p, (s) => s.status === 'error' || s.status === 'running');
  assert.equal(state.status, 'error', state.message);
  await session.dispose();
});

test('stopping a session ends its shell', async () => {
  const p = pane({ launch: 'shell' });
  const { session } = await runUntil(p, (s) => s.status === 'running');
  assert.ok(session.isAlive);
  await session.stop();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(session.isAlive, false);
});
