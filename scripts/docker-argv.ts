/**
 * Prints the `docker` argv a pane would be launched with, for every credential mode.
 * Run after `npm run build` to eyeball the flags without starting a container:
 *
 *   npx esbuild scripts/docker-argv.ts --bundle --platform=node --format=cjs \
 *     --external:node-pty --external:electron --outfile=dist/docker-argv.cjs
 *   node dist/docker-argv.cjs
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRunArgs } from '../src/main/docker.js';
import type { ClaudeConfigMode, ResolvedPane } from '../src/shared/types.js';

// Everything happens in a throwaway folder with an empty fake home. buildRunArgs does real
// work — `copy` mode seeds the pane's Claude home from ~/.claude — and a demo must never
// copy the user's real credentials anywhere. os.homedir() reads these on every call.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'multitask-argv-'));
process.env.HOME = process.env.USERPROFILE = path.join(scratch, 'home');
const workspace = path.join(scratch, 'argv-demo');

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
  // The same function a pane starts with, so what is printed is what would run.
  const { args, warning } = await buildRunArgs(p, workspace);
  console.log(`\n### ${label}`);
  console.log('docker ' + args.join(' '));
  if (warning) console.log('warning: ' + warning);
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
