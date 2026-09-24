/** Tiny DOM helpers shared by the dialogs. */
import type { Theme } from '../shared/themes.js';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('label', { className: 'field' }, [el('span', { textContent: label }), control]);
  if (hint) wrap.append(el('small', { textContent: hint }));
  return wrap;
}

export function numberInput(value: number, min: number, max: number): HTMLInputElement {
  return el('input', { type: 'number', value: String(value), min: String(min), max: String(max) });
}

export function select(
  options: { value: string; label: string; disabled?: boolean }[],
  value: string,
): HTMLSelectElement {
  const s = el('select');
  for (const o of options) {
    s.append(el('option', { value: o.value, textContent: o.label, disabled: !!o.disabled }));
  }
  s.value = value;
  return s;
}

/** A text input backed by a <datalist>, so known values are suggested but not required. */
export function comboInput(
  value: string,
  options: string[],
  placeholder = '',
): { input: HTMLInputElement; node: HTMLElement } {
  const listId = `dl-${Math.random().toString(36).slice(2, 9)}`;
  const list = el('datalist', { id: listId });
  for (const o of options) list.append(el('option', { value: o }));
  const input = el('input', { value, placeholder });
  input.setAttribute('list', listId);
  return { input, node: el('span', { className: 'combo' }, [input, list]) };
}

export const linesToArray = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** Build a modal shell and return the pieces callers fill in. */
export function modal(title: string, onClose?: () => void): {
  overlay: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  alert: (msg: string) => void;
  close: () => void;
} {
  const overlay = el('div', { className: 'overlay' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    onClose?.();
  };

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && overlay.isConnected) close();
  }

  const alertEl = el('div', { className: 'modal-alert hidden' });
  const body = el('div', { className: 'modal-body' });
  const footer = el('footer', { className: 'modal-foot' });

  const box = el('div', { className: 'modal' }, [
    el('header', { className: 'modal-head' }, [
      el('h2', { textContent: title }),
      el('span', { className: 'spacer' }),
      el('button', { className: 'icon', textContent: '✕', onclick: close }),
    ]),
    alertEl,
    body,
    footer,
  ]);

  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  return {
    overlay,
    body,
    footer,
    close,
    alert: (msg: string) => {
      alertEl.textContent = msg;
      alertEl.classList.toggle('hidden', !msg);
    },
  };
}

/**
 * A theme picker: a select plus a live strip of swatches and the theme's one-line note,
 * so the choice can be judged without applying it first.
 */
export function themeField(
  label: string,
  value: string,
  themes: Theme[],
  inheritFrom: string | null,
): { node: HTMLElement; select: HTMLSelectElement } {
  const options = [
    ...(inheritFrom
      ? [{ value: '', label: `inherit (${themes.find((t) => t.id === inheritFrom)?.label ?? inheritFrom})` }]
      : []),
    ...themes.map((t) => ({ value: t.id, label: t.label })),
  ];
  const picker = select(options, value);

  const swatches = el('div', { className: 'swatches' });
  const note = el('small', { className: 'muted' });

  const paint = () => {
    const id = picker.value || inheritFrom || themes[0].id;
    const theme = themes.find((t) => t.id === id) ?? themes[0];
    const p = theme.palette as unknown as Record<string, string>;
    swatches.replaceChildren();
    swatches.style.background = p.background;
    swatches.style.borderColor = p.brightBlack;
    // Body text first, then the colours Claude's output actually leans on.
    for (const key of ['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
      const sw = el('span', { className: 'swatch', title: `${key}: ${p[key]}` });
      sw.style.background = p[key];
      swatches.append(sw);
    }
    note.textContent = theme.note;
  };
  picker.addEventListener('change', paint);
  paint();

  return {
    select: picker,
    node: el('div', { className: 'theme-field' }, [
      field(label, picker),
      swatches,
      note,
    ]),
  };
}
