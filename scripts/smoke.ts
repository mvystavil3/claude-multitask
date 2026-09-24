import { Session } from '../src/main/session.js';
import type { ResolvedPane } from '../src/shared/types.js';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const profile = (process.argv[2] ?? 'cmd') as ResolvedPane['profile'];
const task = process.argv[3] ?? 'Write a file hello.txt containing exactly: multitask works. Then stop.';
// SMOKE_WORKSPACE keeps test runs out of the real workspaces/ folder when needed.
const ws = path.resolve(
  process.env.SMOKE_WORKSPACE || path.join(__dirname, '..', 'workspaces', 'smoke-' + profile),
);
mkdirSync(ws, { recursive: true });

const pane: ResolvedPane = {
  id: 'smoke-' + profile,
  title: 'smoke',
  profile,
  // Unset means WSL's own default distro, which every WSL install has.
  distro: profile === 'wsl' ? process.env.SMOKE_DISTRO || undefined : undefined,
  workspace: ws,
  task,
  launch: (process.env.SMOKE_LAUNCH as 'claude' | 'command' | 'shell') || 'claude',
  command: process.env.SMOKE_COMMAND || '',
  claudeBin: process.env.SMOKE_CLAUDE_BIN || undefined,
  claudeArgs: process.env.SMOKE_CLAUDE_ARGS
    ? process.env.SMOKE_CLAUDE_ARGS.split(' ').filter(Boolean)
    : process.env.SMOKE_CLAUDE_BIN
      ? []
      : ['--permission-mode', 'acceptEdits'],
  env: {},
  autoStart: true,
  autoSubmit: true,
  // The app fills these from defaults via resolvePanes(); the harness must do it itself.
  docker: {
    image: process.env.SMOKE_IMAGE || 'claude-multitask:latest',
    mode: (process.env.SMOKE_DOCKER_MODE as 'run' | 'exec') || 'run',
    containerName: process.env.SMOKE_CONTAINER || 'mt-smoke-docker',
    workdir: '/work',
    shell: ['bash', '-l'],
    claudeConfigMode: (process.env.SMOKE_CLAUDE_MODE as 'shared' | 'copy' | 'none') || 'shared',
    claudeHome: process.env.SMOKE_CLAUDE_HOME || '/root/.claude',
    extraArgs: [],
  },
};

const session = new Session(pane, ws, {
  onData: (_id, chunk) => process.stdout.write(chunk),
  onState: (s) =>
    console.log(`\n\x1b[36m[state] ${s.status}${s.pid ? ' pid=' + s.pid : ''}${s.message ? ' :: ' + s.message : ''} promptSent=${s.promptSent} activity=${s.activity}${s.needsReason ? '(' + s.needsReason + ')' : ''}\x1b[0m`),
});

session.resize(120, 34);
void session.start();

const limit = Number(process.argv[4] ?? 90);
setTimeout(() => {
  console.log('\n\x1b[36m[smoke] time limit reached, stopping\x1b[0m');
  void session.dispose().then(() => setTimeout(() => process.exit(0), 1500));
}, limit * 1000);
