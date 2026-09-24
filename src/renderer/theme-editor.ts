import {
  PALETTE_KEYS,
  auditTheme,
  type TerminalPalette,
  type Theme,
} from '../shared/themes.js';
import { el, field, modal } from './dom.js';

/** Friendlier names than the raw palette keys. */
const LABELS: Partial<Record<keyof TerminalPalette, string>> = {
  background: 'Background',
  foreground: 'Body text',
  cursor: 'Cursor',
  selectionBackground: 'Selection',
  brightBlack: 'Bright black',
  brightRed: 'Bright red',
  brightGreen: 'Bright green',
  brightYellow: 'Bright yellow',
  brightBlue: 'Bright blue',
  brightMagenta: 'Bright magenta',
  brightCyan: 'Bright cyan',
  brightWhite: 'Bright white',
};

const pretty = (key: string) => LABELS[key as keyof TerminalPalette] ?? key;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'scheme';

/**
 * Edit a colour scheme and save it into the config, where it is picked up again on the
 * next launch. Starting from an existing theme rather than a blank palette is deliberate:
 * twenty colours from scratch is a chore, and a tweak of something that already works is
 * what people actually want.
 */
export function openThemeEditor(options: {
  base: Theme;
  existingIds: string[];
  /** Set when editing a saved scheme rather than duplicating one. */
  editingId?: string;
  onSave(theme: Theme): void | Promise<void>;
}): void {
  const { base, existingIds, editingId, onSave } = options;
  const palette: TerminalPalette = { ...base.palette };
  const { overlay, body, footer, alert, close } = modal(
    editingId ? 'Edit colour scheme' : 'Save colour scheme',
  );

  const name = el('input', {
    value: editingId ? base.label : `${base.label} (mine)`,
  });
  const light = el('input', { type: 'checkbox', checked: base.light });
  const preview = el('pre', { className: 'theme-preview' });
  const verdict = el('p', { className: 'muted' });

  function current(): Theme {
    return {
      id: editingId ?? slug(name.value),
      label: name.value.trim() || 'Untitled scheme',
      light: light.checked,
      note: 'Saved scheme.',
      palette,
    };
  }

  /** A miniature terminal so the palette is judged in context, not as loose swatches. */
  function renderPreview(): void {
    preview.replaceChildren();
    preview.style.background = palette.background;
    preview.style.color = palette.foreground;

    const line = (parts: [string, string][]) => {
      const row = document.createElement('div');
      for (const [text, colour] of parts) {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.color = colour;
        row.append(span);
      }
      preview.append(row);
    };
    line([['❯ ', palette.brightGreen], ['refactor the auth module', palette.foreground]]);
    line([['● ', palette.brightBlue], ['Write', palette.foreground], ['(auth.ts)', palette.cyan]]);
    line([['  + added line', palette.green]]);
    line([['  - removed line', palette.red]]);
    line([['  warning: check this', palette.yellow]]);
    line([['  dim secondary text', palette.brightBlack]]);

    const audit = auditTheme(current());
    verdict.className = audit.problems.length ? 'warn' : 'muted';
    verdict.textContent = audit.problems.length
      ? audit.problems.join('; ')
      : `Body ${audit.body.toFixed(1)}:1, dimmest colour ${audit.minAnsi.toFixed(1)}:1 — comfortable and legible.`;
  }

  const grid = el('div', { className: 'colour-grid' });
  for (const key of PALETTE_KEYS) {
    const input = el('input', { type: 'color', value: palette[key] });
    input.addEventListener('input', () => {
      palette[key] = input.value;
      renderPreview();
    });
    grid.append(
      el('label', { className: 'colour-cell', title: key }, [
        input,
        el('span', { textContent: pretty(key) }),
      ]),
    );
  }

  for (const node of [name, light]) node.addEventListener('input', renderPreview);

  body.classList.add('single');
  body.append(
    el('div', { className: 'modal-left wide' }, [
      el('div', { className: 'row' }, [
        field('Name', name),
        field('Light background', light, 'Changes how the window chrome is derived.'),
      ]),
      el('h3', { textContent: 'Preview' }),
      preview,
      verdict,
      el('h3', { textContent: 'Colours' }),
      grid,
    ]),
  );

  footer.append(
    el('span', {
      className: 'muted',
      textContent: 'Saved into multitask.config.json, so it returns next launch.',
    }),
    el('span', { className: 'spacer' }),
    el('button', { textContent: 'Cancel', onclick: close }),
    el('button', {
      className: 'primary',
      textContent: 'Save scheme',
      onclick: async () => {
        const theme = current();
        if (!name.value.trim()) return alert('Give the scheme a name.');
        if (!editingId && existingIds.includes(theme.id)) {
          return alert(`A scheme called "${theme.label}" already exists. Pick another name.`);
        }
        alert('');
        await onSave(theme);
        close();
      },
    }),
  );

  document.body.append(overlay);
  renderPreview();
  name.focus();
}
