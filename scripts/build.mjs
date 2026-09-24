import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

const targets = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(out, 'main/index.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'node-pty'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(out, 'preload/index.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/renderer/app.ts')],
    outfile: path.join(out, 'renderer/app.js'),
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'css' },
  },
];

async function copyStatic() {
  await mkdir(path.join(out, 'renderer'), { recursive: true });
  await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'));
  await cp(path.join(root, 'src/renderer/styles.css'), path.join(out, 'renderer/styles.css'));
  await cp(
    path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'),
    path.join(out, 'renderer/xterm.css'),
  );
}

if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  await copyStatic();
  console.log('[build] watching...');
} else {
  if (existsSync(out)) await rm(out, { recursive: true, force: true });
  await Promise.all(targets.map((t) => build(t)));
  await copyStatic();
  console.log('[build] done');
}
