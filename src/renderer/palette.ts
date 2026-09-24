import { el } from './dom.js';

export interface Command {
  id: string;
  label: string;
  /** Grouping shown on the right of the row, e.g. the pane a command acts on. */
  hint?: string;
  /** Extra words to match against that are not worth showing. */
  keywords?: string;
  run(): void | Promise<void>;
}

/**
 * Subsequence match, the behaviour people expect from a command palette: "sda" finds
 * "Start all". Returns null when it does not match, otherwise a score where lower is
 * better, favouring tight matches near the start of the label.
 */
function score(text: string, query: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  let at = -1;
  let total = 0;
  let previous = -1;
  for (const ch of query.toLowerCase()) {
    at = haystack.indexOf(ch, at + 1);
    if (at === -1) return null;
    // A character right after the previous one is a run, which is worth more.
    total += previous === -1 ? at : (at - previous - 1) * 2;
    previous = at;
  }
  return total;
}

let open: (() => void) | null = null;

export function isPaletteOpen(): boolean {
  return open !== null;
}

/** A single-field fuzzy launcher for every action in the app. */
export function openPalette(commands: Command[]): void {
  if (open) return;

  const overlay = el('div', { className: 'overlay palette-overlay' });
  const input = el('input', {
    className: 'palette-input',
    placeholder: 'Type a command…',
    spellcheck: false,
  });
  const list = el('div', { className: 'palette-list' });
  let matches: Command[] = [];
  let active = 0;

  const close = () => {
    open = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  function render(): void {
    const query = input.value.trim();
    matches = commands
      .map((command) => ({
        command,
        rank: score(`${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`, query),
      }))
      .filter((m): m is { command: Command; rank: number } => m.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 40)
      .map((m) => m.command);

    if (active >= matches.length) active = Math.max(0, matches.length - 1);
    list.replaceChildren();

    if (!matches.length) {
      list.append(el('div', { className: 'palette-empty', textContent: 'No matching command' }));
      return;
    }
    matches.forEach((command, index) => {
      const row = el('div', { className: 'palette-row' + (index === active ? ' active' : '') }, [
        el('span', { className: 'palette-label', textContent: command.label }),
        ...(command.hint ? [el('span', { className: 'palette-hint', textContent: command.hint })] : []),
      ]);
      row.addEventListener('mousemove', () => {
        if (active === index) return;
        active = index;
        render();
      });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(index);
      });
      list.append(row);
    });
    list.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index: number): void {
    const command = matches[index];
    if (!command) return;
    close();
    void command.run();
  }

  // Capture phase: xterm consumes keys once a terminal has focus.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      render();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  overlay.append(el('div', { className: 'palette' }, [input, list]));
  document.body.append(overlay);
  open = close;
  render();
  input.focus();
}
