/**
 * Prints the `docker` argv a pane would be launched with, for every credential mode.
 * Run after `npm run build` to eyeball the flags without starting a container:
 *
 *   npx esbuild scripts/docker-argv.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --external:electron --outfile=dist/docker-argv.cjs
 *   node dist/docker-argv.cjs
 */
import path from 'node:path';
import { claudeMounts, toMountPath } from '../src/main/docker.js';
import type { ClaudeConfigMode, ResolvedPane } from '../src/shared/types.js';

// Bundled to dist/, so the repo root is one level up. The copy mode seeds credentials into
// this folder's .multitask/, which .gitignore keeps out of the repo.
const workspace = path.resolve(__dirname, '..', 'workspaces', 'argv-demo');

function pane(mode: ClaudeConfigMode, overrides: Partial<ResolvedPane['docker']> = {}): ResolvedPane {
  return {
    id: 'argv-demo',
    title: 'argv demo',
    profile: 'docker',
    workspace,
    task: 'demo',
    claudeArgs: ['--permission-mode', 'acceptEdits'],
    env: { MY_TOKEN: 'x', OTHER: 'y' },
    autoStart: false,
    autoSubmit: true,
    docker: {
      image: 'claude-multitask:latest',
      mode: 'run',
      containerName: 'mt-argv-demo',
      workdir: '/work',
      shell: ['bash', '-l'],
      claudeConfigMode: mode,
      claudeHome: '/root/.claude',
      extraArgs: [],
      ...overrides,
    },
  };
}

async function show(label: string, p: ResolvedPane): Promise<void> {
  const d = p.docker;
  const mounts = await claudeMounts(p, workspace);
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
    ...mounts.args,
  ];
  if (d.user) args.push('--user', d.user);
  for (const key of Object.keys(p.env)) args.push('-e', key);
  if (d.claudeConfigMode === 'none' && process.env.ANTHROPIC_API_KEY) {
    args.push('-e', 'ANTHROPIC_API_KEY');
  }
  args.push(...d.extraArgs, d.image, ...d.shell);

  console.log(`\n### ${label}`);
  console.log('docker ' + args.join(' '));
  if (mounts.warning) console.log('warning: ' + mounts.warning);
}

async function main(): Promise<void> {
  await show('claudeConfigMode: shared', pane('shared'));
  await show('claudeConfigMode: copy', pane('copy'));
  await show('claudeConfigMode: none', pane('none'));
  await show(
    'non-root image + hardening',
    pane('copy', {
      image: 'claude-multitask:node22',
      claudeHome: '/home/node/.claude',
      user: '1000:1000',
      extraArgs: ['--memory=4g', '--cpus=2'],
    }),
  );
}

void main();
