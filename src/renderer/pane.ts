import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import type { PaneState, PaneUsage, ResolvedPane } from '../shared/types.js';
import { getTheme } from '../shared/themes.js';
import { isMac, keyIs, keys } from './dom.js';

const ACTIVITY_LABEL: Record<PaneState['activity'], string> = {
  unknown: '',
  ready: 'ready',
  working: 'working',
  'needs-you': 'needs you',
  ended: 'session ended',
};

/** Last path segment, which is what identifies a project at a glance. */
function folderName(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? workspace;
}

/** How the pane's shell reads in its header: the profile, plus where it points. */
function shellLabel(pane: ResolvedPane): string {
  if (pane.profile === 'wsl') return `wsl:${pane.distro ?? 'default'}`;
  if (pane.profile === 'ssh') return `ssh:${pane.ssh.host || '?'}`;
  return pane.profile;
}

/** 950, 12.3k, 4.1M */
function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** The short form for the header: cost when it is known, otherwise tokens. */
function usageShort(u: PaneUsage): string {
  if (u.costUsd !== undefined) return `≈${formatCost(u.costUsd)}`;
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${compactNumber(total)} tok`;
}

function usageDetail(u: PaneUsage, turns: number): string {
  const n = (v: number) => v.toLocaleString();
  return [
    `This conversation${u.model ? ` (${u.model})` : ''}:`,
    `${turns} turn${turns === 1 ? '' : 's'}`,
    `input ${n(u.inputTokens)} · output ${n(u.outputTokens)}`,
    `cache read ${n(u.cacheReadTokens)} · cache write ${n(u.cacheWriteTokens)}`,
    u.costUsd !== undefined
      ? `≈ ${formatCost(u.costUsd)} at API list prices (subscriptions are not billed per token)`
      : 'No list price known for this model, so no cost estimate.',
    'Subagents keep their own transcripts and are not included.',
  ].join('\n');
}

const STATUS_LABEL: Record<PaneState['status'], string> = {
  idle: 'idle',
  spawning: 'starting shell',
  'shell-ready': 'shell ready',
  launching: 'launching',
  running: 'running',
  exited: 'exited',
  error: 'error',
};

export interface PaneCallbacks {
  onFocus(id: string): void;
  onMaximize(id: string): void;
  onEdit(id: string): void;
}

export class PaneView {
  readonly id: string;
  readonly el: HTMLElement;
  private pane: ResolvedPane;
  private term: Terminal;
  private fit: FitAddon;
  private search: SearchAddon;
  private observer: ResizeObserver;
  private titleEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private folderEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private promptBtn!: HTMLButtonElement;
  private searchBar!: HTMLInputElement;
  private lastSize = { cols: 0, rows: 0 };
  /** Previous status, so a restart can be told apart from later updates while starting. */
  private lastStatus: PaneState['status'] = 'idle';
  private disposed = false;

  constructor(pane: ResolvedPane, fontSize: number, private cb: PaneCallbacks) {
    this.id = pane.id;
    this.pane = pane;
    this.el = document.createElement('section');
    this.el.className = 'pane';
    this.el.dataset.id = pane.id;

    const body = this.buildChrome();

    this.term = new Terminal({
      fontSize,
      fontFamily:
        '"Cascadia Mono", Consolas, Menlo, "SF Mono", "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      theme: getTheme(pane.theme).palette,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      // A safety net no palette can provide: the black slot on a dark background (and the
      // white slot on a light one) is unreadable by definition, so xterm nudges any pair
      // below this ratio apart. 3 is low enough that it never touches the theme's own
      // colours, which all clear it by design.
      minimumContrastRatio: 3,
      // Claude's TUI redraws often; smoother scroll keeps the box from tearing.
      smoothScrollDuration: 0,
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.open(body);
    try {
      this.term.loadAddon(new WebglAddon());
    } catch {
      /* fall back to the canvas renderer when WebGL is unavailable */
    }

    this.installClipboard(body);
    this.term.onData((data) => void window.mt.write(this.id, data));
    this.term.onResize(({ cols, rows }) => {
      this.lastSize = { cols, rows };
      void window.mt.resize(this.id, cols, rows);
    });

    body.addEventListener('mousedown', () => this.focus());
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(body);

    void window.mt.replay(this.id).then((text) => {
      if (text && !this.disposed) this.term.write(text);
    });

    this.applyPaneColors();
    this.applyState({ id: pane.id, status: 'idle', promptSent: false, activity: 'unknown', turns: 0 });
  }

  private async copySelection(): Promise<boolean> {
    const text = this.term.getSelection();
    if (!text) return false;
    await window.mt.clipboardWrite(text);
    // Clearing the selection mirrors what a terminal does and confirms the copy visually.
    this.term.clearSelection();
    return true;
  }

  private async pasteClipboard(): Promise<void> {
    const text = await window.mt.clipboardRead();
    // term.paste wraps the text for bracketed-paste mode when the program has it on,
    // which is what stops a multi-line paste being run line by line.
    if (text) this.term.paste(text);
  }

  /**
   * Clipboard bindings. The one that matters is Ctrl+C: it must only copy when there is a
   * selection, otherwise it has to reach the program as an interrupt.
   */
  private installClipboard(body: HTMLElement): void {
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // keyIs matches on any keyboard layout; see dom.ts.
      const is = (letter: string) => keyIs(e, letter);

      /*
       * Returning false only tells xterm to keep its hands off the key; Chromium still
       * runs its own binding. For Ctrl+V that means the text arrives twice, once from
       * here and once from the browser's paste, so anything handled here is also
       * cancelled at the DOM level.
       */
      const handled = (run: () => void) => {
        e.preventDefault();
        run();
        return false;
      };

      // macOS: Cmd is the app's key and Ctrl is entirely the terminal's, so Ctrl+C is always
      // an interrupt. Cmd+C and Cmd+V come from the Edit menu, whose copy and paste events
      // xterm already handles; xterm just has to leave the keystroke itself alone.
      if (isMac) {
        if (!e.metaKey || e.altKey) return true;
        if (is('c') || is('v')) return false;
        if (is('a')) return handled(() => this.term.selectAll());
        if (is('f')) return handled(() => this.toggleSearch(true));
        return true;
      }

      // AltGr arrives as Ctrl+Alt and types characters (Polish AltGr+C is "ć"), so any
      // Alt combination belongs to the program.
      if (!e.ctrlKey || e.altKey) return true;
      if (e.shiftKey && is('c')) return handled(() => void this.copySelection());
      if (!e.shiftKey && is('v')) return handled(() => void this.pasteClipboard());
      if (!e.shiftKey && is('c') && this.term.hasSelection()) {
        return handled(() => void this.copySelection());
      }
      if (e.shiftKey && is('a')) return handled(() => this.term.selectAll());
      // Plain Ctrl+F stays with the program (readline's forward-char).
      if (e.shiftKey && is('f')) return handled(() => this.toggleSearch(true));
      // Ctrl+Shift+V is left alone: Chromium delivers it as a paste event that xterm
      // already handles correctly, so intercepting it would double the text.
      return true;
    });

    // Right-click copies a selection when there is one, and pastes otherwise — the
    // behaviour Windows terminal users already have in their fingers.
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void this.copySelection().then((copied) => {
        if (!copied) return this.pasteClipboard();
      });
    });
  }

  /** Tint the pane's own surfaces from its palette, so an overridden theme looks whole. */
  private applyPaneColors(): void {
    const p = getTheme(this.pane.theme).palette;
    this.el.style.setProperty('--bg-term', p.background);
    this.el.style.setProperty('--border', p.brightBlack);
    this.el.style.setProperty('--fg-faint', p.white);
  }

  private buildChrome(): HTMLElement {
    const header = document.createElement('header');
    header.className = 'pane-head';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'dot';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'pane-title';

    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'badge';

    this.folderEl = document.createElement('button');
    this.folderEl.className = 'pane-folder';
    this.folderEl.addEventListener('click', (e) => {
      e.stopPropagation();
      void window.mt.openWorkspace(this.id);
    });

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const actions = document.createElement('span');
    actions.className = 'pane-actions';

    const button = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      actions.append(b);
      return b;
    };

    button('▶', 'Start / restart this terminal', () => void window.mt.restart(this.id));
    button('■', 'Stop this terminal', () => void window.mt.stop(this.id));
    this.promptBtn = button('⏎', 'Send the task prompt to Claude now', () =>
      void window.mt.sendPrompt(this.id),
    );
    button('⌕', isMac ? 'Search this terminal (Cmd+F)' : 'Search this terminal (Ctrl+Shift+F)', () =>
      this.toggleSearch(),
    );
    button('📁', 'Open this terminal’s folder', () => void window.mt.openWorkspace(this.id));
    button('✎', 'Edit this terminal', () => this.cb.onEdit(this.id));
    button('⤢', keys('Maximize / restore (Ctrl+Shift+M)'), () => this.cb.onMaximize(this.id));

    header.append(this.statusEl, this.titleEl, this.folderEl, this.badgeEl, spacer, actions);

    this.noteEl = document.createElement('div');
    this.noteEl.className = 'pane-note hidden';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'pane-search hidden';
    this.searchBar = document.createElement('input');
    this.searchBar.placeholder = 'Find in terminal… (Enter next, Shift+Enter previous)';
    this.searchBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) this.search.findPrevious(this.searchBar.value);
      else if (e.key === 'Enter') this.search.findNext(this.searchBar.value);
      else if (e.key === 'Escape') this.toggleSearch(false);
      e.stopPropagation();
    });
    searchWrap.append(this.searchBar);

    const body = document.createElement('div');
    body.className = 'pane-body';

    this.el.append(header, this.noteEl, searchWrap, body);
    return body;
  }

  private toggleSearch(force?: boolean): void {
    const wrap = this.el.querySelector('.pane-search')!;
    const show = force ?? wrap.classList.contains('hidden');
    wrap.classList.toggle('hidden', !show);
    if (show) this.searchBar.focus();
    else this.term.focus();
    this.refit();
  }

  updateConfig(pane: ResolvedPane): void {
    const themeChanged = this.pane.theme !== pane.theme;
    this.pane = pane;
    if (themeChanged) {
      this.term.options.theme = getTheme(pane.theme).palette;
      this.applyPaneColors();
    }
    this.titleEl.textContent = pane.title;
    this.badgeEl.textContent = shellLabel(pane);
    const runs =
      pane.launch === 'command' ? pane.command : pane.launch === 'shell' ? 'shell only' : 'claude';
    this.el.title = `${pane.id}
folder: ${pane.workspace}
runs: ${runs}`;
    // The folder is no longer implied by the pane's name, so it has to be visible.
    this.folderEl.textContent = folderName(pane.workspace);
    this.folderEl.title = pane.workspace;
  }

  applyState(state: PaneState): void {
    // A session always begins at 'spawning', and its output only follows that state.
    const started = state.status === 'spawning' && this.lastStatus !== 'spawning';
    if (started && this.pane.clearOnRestart) this.clear();
    this.lastStatus = state.status;

    this.el.dataset.status = state.status;
    // Activity comes from Claude's own hooks and is what the attention queue reads;
    // status is about the terminal process itself.
    this.el.dataset.activity = state.activity;
    this.statusEl.dataset.status = state.status;
    this.statusEl.dataset.activity = state.activity;
    this.statusEl.title = ACTIVITY_LABEL[state.activity] || STATUS_LABEL[state.status];

    const bits = [shellLabel(this.pane)];
    if (state.activity === 'working') {
      bits.push(state.tool ? `running ${state.tool}` : 'working');
    } else if (state.activity === 'needs-you') {
      bits.push(state.needsReason === 'permission' ? 'wants permission' : 'waiting for you');
    } else if (state.activity === 'ended') {
      bits.push('session ended');
    } else {
      bits.push(STATUS_LABEL[state.status]);
    }
    if (state.turns > 0) bits.push(`${state.turns} turn${state.turns === 1 ? '' : 's'}`);
    if (state.usage) bits.push(usageShort(state.usage));
    if (state.status === 'exited') bits.push(`code ${state.exitCode ?? '?'}`);
    this.badgeEl.textContent = bits.join(' · ');
    this.badgeEl.title = state.usage ? usageDetail(state.usage, state.turns) : '';

    this.promptBtn.disabled = state.status !== 'running' || !this.pane.task.trim();
    this.promptBtn.classList.toggle('accent', state.status === 'running' && !state.promptSent);

    const show = Boolean(state.message);
    this.noteEl.textContent = state.message ?? '';
    this.noteEl.classList.toggle('hidden', !show);
    this.noteEl.classList.toggle('error', state.status === 'error');
    if (show) this.refit();
  }

  /** Wipe the screen and scrollback, and any modes the previous program left switched on. */
  clear(): void {
    if (!this.disposed) this.term.reset();
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = size;
    this.refit();
  }

  focus(): void {
    this.cb.onFocus(this.id);
    this.term.focus();
  }

  /** Re-measure, then push the new size to the PTY only when it actually changed. */
  refit(): void {
    if (this.disposed || !this.el.isConnected) return;
    requestAnimationFrame(() => {
      try {
        const dims = this.fit.proposeDimensions();
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
        if (dims.cols === this.lastSize.cols && dims.rows === this.lastSize.rows) return;
        this.fit.fit();
      } catch {
        /* the pane can be measured mid-layout while hidden */
      }
    });
  }

  write(chunk: string): void {
    if (!this.disposed) this.term.write(chunk);
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
