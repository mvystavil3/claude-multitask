import type { AppConfig, PaneState, Preflight, ResourceSample } from '../shared/types.js';
import type { Snapshot } from '../shared/ipc.js';
import { allThemes, chromeVars, getTheme, setCustomThemes } from '../shared/themes.js';
import { PaneView } from './pane.js';
import { openSettings } from './settings.js';
import { openImagesDialog } from './images.js';
import { isPaletteOpen, openPalette, type Command } from './palette.js';

import type { MtApi } from '../preload/index.js';

declare global {
  interface Window {
    mt: MtApi;
  }
}

const grid = document.getElementById('grid') as HTMLElement;
const toolbar = document.getElementById('toolbar') as HTMLElement;
const toasts = document.getElementById('toasts') as HTMLElement;

const views = new Map<string, PaneView>();
let config: AppConfig;
let preflight: Preflight | null = null;
let focusedId: string | null = null;
let maximizedId: string | null = null;
/** Latest state per pane, so the toolbar counter and the palette can read it. */
const states = new Map<string, PaneState>();
let countsEl: HTMLElement | null = null;
let gaugesEl: HTMLElement | null = null;
let lastSample: ResourceSample | null = null;

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  toasts.append(node);
  setTimeout(() => node.classList.add('fade'), kind === 'error' ? 7000 : 3500);
  setTimeout(() => node.remove(), kind === 'error' ? 7600 : 4100);
}

function buildToolbar(): void {
  toolbar.replaceChildren();

  const button = (label: string, title: string, fn: () => void, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.className = cls;
    b.addEventListener('click', fn);
    toolbar.append(b);
    return b;
  };

  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'Claude Multitask';
  toolbar.append(brand);

  const gridBox = document.createElement('span');
  gridBox.className = 'grid-size';
  // The clamp has to come from the same place as the min/max attributes, or a field can
  // hand the config a value its own schema rejects.
  const mk = (value: number, min: number, max: number, onChange: (v: number) => void) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('change', () => {
      const clamped = Math.max(min, Math.min(max, Math.round(Number(input.value)) || min));
      input.value = String(clamped);
      onChange(clamped);
    });
    return input;
  };
  const colsInput = mk(config.grid.cols, 1, 6, (v) =>
    void saveConfig({ ...config, grid: { ...config.grid, cols: v } }),
  );
  const rowsInput = mk(config.grid.rows, 1, 6, (v) =>
    void saveConfig({ ...config, grid: { ...config.grid, rows: v } }),
  );
  gridBox.append(document.createTextNode('grid'), colsInput, document.createTextNode('×'), rowsInput);
  toolbar.append(gridBox);

  gaugesEl = document.createElement('span');
  gaugesEl.className = 'gauges';
  gaugesEl.title = 'Machine load';
  toolbar.append(gaugesEl);
  renderGauges();

  countsEl = document.createElement('span');
  countsEl.className = 'counts';
  countsEl.addEventListener('click', () => focusNextAttention());
  toolbar.append(countsEl);
  renderCounts();

  button('Start all', 'Start every terminal that is not running', () => void window.mt.startAll(), 'primary');
  button('Stop all', 'Stop every running terminal', () => void window.mt.stopAll());
  button('Restart all', 'Stop then start every terminal', () => void window.mt.restartAll());

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  toolbar.append(spacer);

  const fontBox = document.createElement('span');
  fontBox.className = 'grid-size';
  const fontInput = mk(config.defaults.fontSize, 8, 32, (v) =>
    void saveConfig({ ...config, defaults: { ...config.defaults, fontSize: v } }),
  );
  fontBox.append(document.createTextNode('font'), fontInput);
  toolbar.append(fontBox);

  button('Commands', 'Every action, searchable (Ctrl+K)', () => openPalette(buildCommands()));
  button('Config file', 'Open multitask.config.json in the default editor', () =>
    void window.mt.openConfigFile(),
  );
  button('Reload', 'Re-read the config file from disk', () => void window.mt.reloadConfig());
  button('Settings', 'Edit terminals and defaults (Ctrl+,)', () => showSettings());
}

async function saveConfig(next: AppConfig): Promise<void> {
  const snap = await window.mt.saveConfig(next);
  applySnapshot(snap);
}

function showSettings(focusPaneId?: string): void {
  openSettings({ config, preflight, focusPaneId, onSave: (next) => saveConfig(next) });
}

/** Retune the window chrome to the default theme so the frame and terminals match. */
function applyChrome(): void {
  const theme = getTheme(config.defaults.theme);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(chromeVars(theme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.light ? 'light' : 'dark';
}

function layoutGrid(): void {
  grid.style.setProperty('--cols', String(config.grid.cols));
  grid.style.setProperty('--rows', String(config.grid.rows));
  // Cells get an explicit height so a pane count above cols*rows scrolls instead of squashing.
  grid.classList.toggle('maximized', maximizedId !== null);
  for (const [id, view] of views) {
    view.el.classList.toggle('hidden', maximizedId !== null && id !== maximizedId);
    view.refit();
  }
  renderPlaceholder();
}

let placeholder: HTMLElement | null = null;
function renderPlaceholder(): void {
  placeholder?.remove();
  placeholder = null;
  const cells = config.grid.cols * config.grid.rows;
  if (maximizedId !== null || views.size >= cells) return;
  const node = document.createElement('button');
  node.className = 'pane add-pane';
  node.textContent = '+ Add terminal';
  node.addEventListener('click', () => showSettings());
  grid.append(node);
  placeholder = node;
}

function applySnapshot(snap: Snapshot): void {
  config = snap.config;
  // Saved schemes must be registered before any pane or the chrome resolves a theme id.
  setCustomThemes(config.customThemes);
  const panes = snap.panes;
  const ids = new Set(panes.map((p) => p.id));

  for (const [id, view] of [...views]) {
    if (!ids.has(id)) {
      view.dispose();
      views.delete(id);
      if (maximizedId === id) maximizedId = null;
      if (focusedId === id) focusedId = null;
    }
  }

  for (const pane of panes) {
    let view = views.get(pane.id);
    if (!view) {
      view = new PaneView(pane, config.defaults.fontSize, {
        onFocus: (id) => setFocus(id),
        onMaximize: (id) => {
          maximizedId = maximizedId === id ? null : id;
          layoutGrid();
        },
        onEdit: (id) => showSettings(id),
      });
      views.set(pane.id, view);
    }
    view.updateConfig(pane);
    view.setFontSize(config.defaults.fontSize);
    grid.append(view.el);
  }

  // Keep DOM order equal to config order.
  for (const pane of panes) {
    const view = views.get(pane.id);
    if (view) grid.append(view.el);
  }

  for (const state of snap.states) {
    states.set(state.id, state);
    views.get(state.id)?.applyState(state);
  }

  applyChrome();
  buildToolbar();
  layoutGrid();
  if (focusedId && views.has(focusedId)) setFocus(focusedId);
}

/**
 * A short, soft two-tone chime, synthesised so there is no audio file to ship. Off unless
 * the user turns sound on, and never played for a pane that was already waiting.
 */
let audio: AudioContext | null = null;
function chime(): void {
  if (!config.defaults.sound) return;
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    for (const [at, hz] of [
      [0, 660],
      [0.12, 880],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      // A quick fade in and out; a raw gate would click.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.05, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.2);
    }
  } catch {
    /* audio is a nicety; never let it break the UI */
  }
}

/** Panes waiting on you, in grid order, so cycling follows the layout. */
function panesNeedingYou(): string[] {
  return config.panes
    .map((p) => p.id)
    .filter((id) => states.get(id)?.activity === 'needs-you');
}

/** Jump to the next pane that wants attention, wrapping past the current one. */
function focusNextAttention(): void {
  const queue = panesNeedingYou();
  if (!queue.length) {
    toast('Nothing is waiting on you.');
    return;
  }
  const at = focusedId ? queue.indexOf(focusedId) : -1;
  const next = queue[(at + 1) % queue.length];
  const view = views.get(next);
  if (!view) return;
  if (maximizedId !== null) {
    maximizedId = next;
    layoutGrid();
  }
  view.focus();
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** Green below 60%, orange to 85%, red above — the usual "is it coping" bands. */
function loadLevel(percent: number): string {
  if (percent >= 85) return 'high';
  if (percent >= 60) return 'medium';
  return 'low';
}

function renderGauges(): void {
  if (!gaugesEl) return;
  gaugesEl.replaceChildren();
  const sample = lastSample;
  if (!sample) return;

  const dot = (kind: string, percent: number, tip: string) => {
    const node = document.createElement('span');
    node.className = 'dot gauge';
    node.dataset.load = loadLevel(percent);
    node.title = tip;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', tip);
    gaugesEl!.append(node);
    void kind;
  };

  dot(
    'cpu',
    sample.cpuPercent,
    `CPU ${sample.cpuPercent.toFixed(0)}% of ${sample.cores} cores
` +
      `${sample.runningPanes} terminal${sample.runningPanes === 1 ? '' : 's'} running`,
  );
  dot(
    'mem',
    sample.memPercent,
    `Memory ${sample.memPercent.toFixed(0)}% — ` +
      `${gb(sample.usedMemBytes)} of ${gb(sample.totalMemBytes)} GB in use
` +
      `This app: ${gb(sample.appMemBytes)} GB`,
  );
}

function renderCounts(): void {
  if (!countsEl) return;
  let needs = 0;
  let working = 0;
  for (const pane of config.panes) {
    const activity = states.get(pane.id)?.activity;
    if (activity === 'needs-you') needs += 1;
    else if (activity === 'working') working += 1;
  }
  countsEl.replaceChildren();
  countsEl.classList.toggle('none', needs === 0);
  countsEl.title = needs
    ? 'Jump to the next pane waiting on you (F8)'
    : 'Nothing is waiting on you';

  const part = (cls: string, activity: string, text: string) => {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.activity = activity;
    const wrap = document.createElement('span');
    wrap.className = `count ${cls}`;
    wrap.append(dot, document.createTextNode(text));
    return wrap;
  };
  // "all quiet" only when nothing at all is happening, or it contradicts "1 working".
  if (needs) countsEl.append(part('needs', 'needs-you', `${needs} need you`));
  if (working) countsEl.append(part('working', 'working', `${working} working`));
  if (!needs && !working) countsEl.append(part('idle', 'ready', 'all quiet'));
}

function setFocus(id: string): void {
  focusedId = id;
  for (const [paneId, view] of views) view.el.classList.toggle('focused', paneId === id);
}

function focusIndex(index: number): void {
  const pane = config.panes[index];
  if (!pane) return;
  const view = views.get(pane.id);
  if (!view) return;
  if (maximizedId !== null) {
    maximizedId = pane.id;
    layoutGrid();
  }
  view.focus();
}

/** Everything the app can do, as a flat list for the palette. */
function buildCommands(): Command[] {
  const commands: Command[] = [
    { id: 'start-all', label: 'Start all terminals', run: () => window.mt.startAll() },
    { id: 'stop-all', label: 'Stop all terminals', run: () => window.mt.stopAll() },
    { id: 'restart-all', label: 'Restart all terminals', run: () => window.mt.restartAll() },
    {
      id: 'next-attention',
      label: 'Go to next pane waiting on you',
      hint: 'F8',
      keywords: 'attention needs',
      run: () => focusNextAttention(),
    },
    { id: 'settings', label: 'Open settings', hint: 'Ctrl+,', run: () => showSettings() },
    { id: 'images', label: 'Open Docker images', run: () => openImagesDialog() },
    { id: 'config', label: 'Open the config file', run: () => window.mt.openConfigFile() },
    { id: 'reload', label: 'Reload config from disk', run: () => window.mt.reloadConfig() },
    { id: 'add', label: 'Add a terminal', run: () => showSettings() },
  ];

  for (const theme of allThemes()) {
    commands.push({
      id: `theme-${theme.id}`,
      label: `Theme: ${theme.label}`,
      hint: theme.note,
      keywords: 'colour color',
      run: () => saveConfig({ ...config, defaults: { ...config.defaults, theme: theme.id } }),
    });
  }

  commands.push({
    id: 'sound',
    label: config.defaults.sound ? 'Turn the attention sound off' : 'Turn the attention sound on',
    keywords: 'chime alert mute',
    run: () =>
      saveConfig({ ...config, defaults: { ...config.defaults, sound: !config.defaults.sound } }),
  });

  for (const pane of config.panes) {
    const name = pane.title || pane.id;
    const state = states.get(pane.id);
    const hint = state?.activity === 'needs-you' ? `${name} · waiting on you` : name;
    commands.push(
      { id: `focus-${pane.id}`, label: `Go to ${name}`, hint, run: () => views.get(pane.id)?.focus() },
      { id: `restart-${pane.id}`, label: `Restart ${name}`, hint, run: () => window.mt.restart(pane.id) },
      {
        id: `fresh-${pane.id}`,
        label: `Start a fresh session in ${name}`,
        hint,
        keywords: 'new clear reset conversation',
        run: () => window.mt.freshSession(pane.id),
      },
      { id: `stop-${pane.id}`, label: `Stop ${name}`, hint, run: () => window.mt.stop(pane.id) },
      {
        id: `send-${pane.id}`,
        label: `Send the task to ${name}`,
        hint,
        run: () => window.mt.sendPrompt(pane.id),
      },
      {
        id: `folder-${pane.id}`,
        label: `Open the folder for ${name}`,
        hint,
        run: () => window.mt.openWorkspace(pane.id),
      },
      {
        id: `move-${pane.id}`,
        label: `Move ${name} to another folder…`,
        hint,
        keywords: 'workspace reassign project directory switch',
        run: async () => {
          const current = config.panes.find((p) => p.id === pane.id);
          const picked = await window.mt.pickFolder(current?.workspace);
          if (!picked) return;
          await saveConfig({
            ...config,
            panes: config.panes.map((p) => (p.id === pane.id ? { ...p, workspace: picked } : p)),
          });
        },
      },
      { id: `edit-${pane.id}`, label: `Edit ${name}`, hint, run: () => showSettings(pane.id) },
    );
  }
  return commands;
}

function registerHotkeys(): void {
  // Capture phase: a focused terminal consumes Ctrl+digit (Ctrl+3 is ESC, Ctrl+2 is NUL)
  // and stops the event, so app shortcuts registered on bubble never fire from a pane.
  window.addEventListener(
    'keydown',
    (e) => {
      if (isPaletteOpen() || document.querySelector('.overlay')) return;
      const key = e.key.toLowerCase();
      let action: (() => void) | null = null;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'k') {
        action = () => openPalette(buildCommands());
      } else if (e.key === 'F8') {
        action = () => focusNextAttention();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        action = () => focusIndex(Number(e.key) - 1);
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'm') {
        action = () => {
          maximizedId = maximizedId === null ? focusedId : null;
          layoutGrid();
        };
      } else if (e.ctrlKey && !e.altKey && e.key === ',') {
        action = () => showSettings(focusedId ?? undefined);
      }
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    },
    true,
  );

  // Escape belongs to the program in a focused terminal (it interrupts Claude), so it only
  // restores a maximized pane when focus is on the app's own chrome.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || maximizedId === null) return;
    if ((e.target as Element | null)?.closest?.('.xterm')) return;
    maximizedId = null;
    layoutGrid();
  });
}

async function main(): Promise<void> {
  const snap = await window.mt.snapshot();
  config = snap.config;
  setCustomThemes(config.customThemes);
  applySnapshot(snap);
  registerHotkeys();

  window.mt.onData(({ id, chunk }) => views.get(id)?.write(chunk));
  window.mt.onState((state: PaneState) => {
    const was = states.get(state.id)?.activity;
    states.set(state.id, state);
    views.get(state.id)?.applyState(state);
    renderCounts();
    // Only on the transition: later updates to a waiting pane must not chime again.
    if (state.activity === 'needs-you' && was !== 'needs-you') chime();
  });
  window.mt.onConfig((s) => applySnapshot(s));
  window.mt.onToast((t) => toast(t.message, t.kind));
  window.mt.onResources((sample) => {
    lastSample = sample;
    renderGauges();
  });
  window.addEventListener('resize', () => {
    for (const view of views.values()) view.refit();
  });

  preflight = await window.mt.preflight();
  // Only worth saying when a Windows pane actually expects to find claude on PATH.
  const needsHostClaude = snap.panes.some(
    (p) =>
      p.launch === 'claude' && !p.claudeBin && (p.profile === 'cmd' || p.profile === 'powershell'),
  );
  if (!preflight.claudeOnPath && needsHostClaude) {
    toast('claude was not found on PATH. Windows terminals will fail until it is installed.', 'error');
  }
}

void main();
