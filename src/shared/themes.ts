/**
 * Terminal themes, chosen and tuned for long sessions.
 *
 * Contrast between body text and background is the thing that decides eye comfort. Too
 * little and you squint; too much (white on black is 21:1) and you get glare and
 * halation. Everything here lands between roughly 5:1 and 11:1, and every ANSI colour
 * clears 3:1 against its own background so Claude Code's coloured output stays readable.
 *
 * Two deliberate departures from the upstream palettes:
 *  - Bright slots are real lighter colours. Solarized's official mapping repurposes them
 *    as greys, which makes TUIs that use bright colours render wrong.
 *  - Gruvbox's normal red and Catppuccin Latte's yellow and green were too dim to read
 *    against their own backgrounds (2.7:1 and 2.3:1), which matters because diffs are
 *    coloured. They are adjusted here.
 *
 * `scripts/check-themes.ts` re-measures all of this.
 */

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  label: string;
  /** True for themes with a light background, which flips how chrome is derived. */
  light: boolean;
  /** Set when a theme is deliberately high contrast, so the checker does not flag it. */
  highContrast?: boolean;
  /** One line on who the theme is for, shown in Settings. */
  note: string;
  palette: TerminalPalette;
}

export const THEMES: Theme[] = [
  {
    id: 'everforest-dark',
    label: 'Everforest Dark',
    light: false,
    note: 'Warm grey-green, low saturation. The best all-round balance.',
    palette: {
      background: '#2d353b',
      foreground: '#d3c6aa',
      cursor: '#d3c6aa',
      selectionBackground: '#475258',
      black: '#343f44',
      red: '#e67e80',
      green: '#a7c080',
      yellow: '#dbbc7f',
      blue: '#7fbbb3',
      magenta: '#d699b6',
      cyan: '#83c092',
      white: '#d3c6aa',
      brightBlack: '#868d80',
      brightRed: '#ec9a9c',
      brightGreen: '#b8cd99',
      brightYellow: '#e4cb9b',
      brightBlue: '#9acdc6',
      brightMagenta: '#e0b0c6',
      brightCyan: '#9bceaa',
      brightWhite: '#fff9e8',
    },
  },
  {
    id: 'selenized-dark',
    label: 'Selenized Dark',
    light: false,
    note: 'Deep teal. Solarized’s comfort with its legibility problems fixed.',
    palette: {
      background: '#103c48',
      foreground: '#adbcbc',
      cursor: '#cad8d9',
      selectionBackground: '#325b66',
      black: '#184956',
      red: '#fa5750',
      green: '#75b938',
      yellow: '#dbb32d',
      blue: '#4695f7',
      magenta: '#f275be',
      cyan: '#41c7b9',
      white: '#cad8d9',
      brightBlack: '#2d5b69',
      brightRed: '#ff665c',
      brightGreen: '#84c747',
      brightYellow: '#ebc13d',
      brightBlue: '#58a3ff',
      brightMagenta: '#ff84cd',
      brightCyan: '#53d6c7',
      brightWhite: '#dde4e4',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    light: false,
    note: 'The original low-strain palette. Softest dark option.',
    palette: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      selectionBackground: '#12404f',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#31606b',
      brightRed: '#f4574f',
      brightGreen: '#a5bd00',
      brightYellow: '#d9a700',
      brightBlue: '#4aa8ef',
      brightMagenta: '#ec5a9e',
      brightCyan: '#3dbfb4',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    light: false,
    note: 'Cool arctic blue-grey, very uniform.',
    palette: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d08770',
      brightGreen: '#b6cf9e',
      brightYellow: '#f0d8a8',
      brightBlue: '#93b3cf',
      brightMagenta: '#c9a0c0',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    light: false,
    note: 'Warm retro browns. Crisper, still warm. Red brightened to stay readable.',
    palette: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#504945',
      black: '#3c3836',
      red: '#fb4934',
      green: '#a9b125',
      yellow: '#d79921',
      blue: '#7daea3',
      magenta: '#c98aa6',
      cyan: '#8ec07c',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fd6b5a',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#a3cf92',
      brightWhite: '#fbf1c7',
    },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    light: false,
    note: 'Muted pastel on deep violet. Best colour separation of the set.',
    palette: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#414458',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f5a3bc',
      brightGreen: '#bbe9b7',
      brightYellow: '#fbe9c4',
      brightBlue: '#a3c5fb',
      brightMagenta: '#f8d2ee',
      brightCyan: '#aae8de',
      brightWhite: '#e6e9f4',
    },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte (light)',
    light: true,
    note: 'Light, soft blue-grey text. For daylight. Yellow and green darkened to read.',
    palette: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#4c4f69',
      selectionBackground: '#ccd0da',
      black: '#5c5f77',
      red: '#c4102f',
      green: '#2f7d1f',
      yellow: '#9a6407',
      blue: '#1e66f5',
      magenta: '#c74aa6',
      cyan: '#127a80',
      white: '#8c90a1',
      brightBlack: '#6c6f85',
      brightRed: '#d81e3c',
      brightGreen: '#3a9128',
      brightYellow: '#b07a10',
      brightBlue: '#3a7bf7',
      brightMagenta: '#da62b8',
      brightCyan: '#169097',
      brightWhite: '#acb0be',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    light: true,
    note: 'Cream paper. The softest light option.',
    palette: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#586e75',
      selectionBackground: '#e6dfc8',
      black: '#073642',
      red: '#dc322f',
      green: '#6d7f00',
      yellow: '#a07800',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2a8f86',
      white: '#93a1a1',
      brightBlack: '#657b83',
      brightRed: '#cb4b16',
      brightGreen: '#859900',
      brightYellow: '#b58900',
      brightBlue: '#3a9ad9',
      brightMagenta: '#6c71c4',
      brightCyan: '#2aa198',
      brightWhite: '#eee8d5',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight (high contrast)',
    light: false,
    highContrast: true,
    note: 'The app’s original theme. Crisp, but 14:1 body contrast can glare.',
    palette: {
      background: '#0b0f14',
      foreground: '#d7dde5',
      cursor: '#58a6ff',
      selectionBackground: '#2b4b6b',
      black: '#1b2028',
      red: '#ff6b6b',
      green: '#7ee787',
      yellow: '#e3b341',
      blue: '#79c0ff',
      magenta: '#d2a8ff',
      cyan: '#76e3ea',
      white: '#c9d1d9',
      brightBlack: '#5a6472',
      brightRed: '#ffa198',
      brightGreen: '#adf5bd',
      brightYellow: '#f2cc60',
      brightBlue: '#a5d6ff',
      brightMagenta: '#e2c5ff',
      brightCyan: '#b3f0f5',
      brightWhite: '#f0f6fc',
    },
  },
];

export const DEFAULT_THEME_ID = 'everforest-dark';

/**
 * Themes the user saved themselves. They live in multitask.config.json, so they come back
 * on the next launch, and both processes register them from the same config.
 */
let customThemes: Theme[] = [];

export function setCustomThemes(list: Theme[] | undefined): void {
  customThemes = list ?? [];
}

export function allThemes(): Theme[] {
  return [...THEMES, ...customThemes];
}

export function isCustomTheme(id: string): boolean {
  return customThemes.some((t) => t.id === id);
}

export function getTheme(id: string | undefined): Theme {
  const themes = allThemes();
  return themes.find((t) => t.id === id) ?? themes.find((t) => t.id === DEFAULT_THEME_ID)!;
}

export const PALETTE_KEYS: (keyof TerminalPalette)[] = [
  'background',
  'foreground',
  'cursor',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

// ---------- chrome derivation ----------

function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Blend `amount` of `b` into `a`. */
function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const c = (x: number, y: number) => clamp(x + (y - x) * amount);
  return (
    '#' +
    [c(ar, br), c(ag, bg), c(ab, bb)].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Blend `b` into `a` as far as possible without dropping below `target` contrast against
 * `against`. Used for the dim text colours: the gentle themes have so little contrast to
 * spare that a fixed blend makes hints unreadable.
 */
function fadeToward(a: string, b: string, max: number, against: string, target: number): string {
  let best = a;
  for (let t = 0; t <= max + 1e-9; t += 0.05) {
    const candidate = mix(a, b, t);
    if (contrast(candidate, against) < target) break;
    best = candidate;
  }
  return best;
}

/**
 * A filled button needs its label to be readable, and a mid-tone accent fails that in both
 * directions. Pick the better of near-black and white, then push the accent away from it
 * until the pair clears AA.
 */
function accentButton(accent: string): { bg: string; fg: string } {
  const dark = '#0b0f14';
  const fg = contrast('#ffffff', accent) >= contrast(dark, accent) ? '#ffffff' : dark;
  let bg = accent;
  for (let i = 0; i < 14 && contrast(fg, bg) < 4.5; i += 1) {
    bg = mix(bg, fg === '#ffffff' ? '#000000' : '#ffffff', 0.08);
  }
  return { bg, fg };
}

function relativeLuminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parse(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Derive the app chrome from the terminal palette, so the window and the terminals read
 * as one surface. Deriving rather than hand-authoring keeps every theme coherent and
 * means a new palette needs no extra colour work.
 */
export function chromeVars(theme: Theme): Record<string, string> {
  const p = theme.palette;
  const bg = p.background;
  const fg = p.foreground;
  // On a light theme "recede" means toward white; on a dark one, toward black.
  const recede = theme.light ? '#ffffff' : '#000000';
  const accent = theme.light ? p.blue : p.brightBlue;
  const button = accentButton(accent);

  return {
    '--bg': bg,
    '--bg-term': bg,
    '--bg-raised': mix(bg, fg, theme.light ? 0.04 : 0.06),
    '--bg-input': mix(bg, recede, theme.light ? 0.55 : 0.3),
    '--bg-hover': mix(bg, fg, theme.light ? 0.1 : 0.14),
    '--border': mix(bg, fg, theme.light ? 0.2 : 0.18),
    '--border-focus': accent,
    '--fg': fg,
    '--fg-dim': fadeToward(fg, bg, 0.45, bg, 3.2),
    '--fg-faint': fadeToward(fg, bg, 0.65, bg, 2.5),
    '--accent': accent,
    // The filled button gets its own background so its label can clear AA.
    '--accent-bg': button.bg,
    '--accent-fg': button.fg,
    '--ok': p.green,
    '--warn': p.yellow,
    '--danger': p.red,
    '--note-warn-bg': mix(bg, p.yellow, 0.14),
    '--note-error-bg': mix(bg, p.red, 0.14),
    '--shadow': theme.light ? 'rgba(0, 0, 0, 0.18)' : 'rgba(0, 0, 0, 0.45)',
    '--overlay': theme.light ? 'rgba(40, 40, 50, 0.4)' : 'rgba(0, 0, 0, 0.6)',
  };
}

// ---------- measurement ----------

const ANSI_KEYS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

export interface ThemeAudit {
  body: number;
  minAnsi: number;
  minAnsiName: string;
  redGreen: number;
  problems: string[];
}

/** Rough perceptual distance, enough to catch two colours that look alike. */
function separation(a: string, b: string): number {
  const [ra, ga, ba] = parse(a);
  const [rb, gb, bb] = parse(b);
  const rm = (ra + rb) / 2;
  return Math.sqrt(
    (2 + rm / 256) * (ra - rb) ** 2 + 4 * (ga - gb) ** 2 + (2 + (255 - rm) / 256) * (ba - bb) ** 2,
  );
}

/**
 * Measure a theme the way `npm run check:themes` does, so a hand-edited scheme gets the
 * same warnings before it is saved.
 */
export function auditTheme(theme: Theme): ThemeAudit {
  const p = theme.palette;
  const body = contrast(p.foreground, p.background);
  const ratios = ANSI_KEYS.map((name) => ({ name, ratio: contrast(p[name], p.background) }));
  const dimmest = ratios.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
  const redGreen = separation(p.red, p.green);

  const problems: string[] = [];
  if (body < 4.5) problems.push(`body text ${body.toFixed(1)}:1 is below AA`);
  if (body > 13 && !theme.highContrast) problems.push(`body text ${body.toFixed(1)}:1 may glare`);
  if (dimmest.ratio < 3) {
    problems.push(`${dimmest.name} ${dimmest.ratio.toFixed(1)}:1 is hard to read`);
  }
  if (redGreen < 150) problems.push(`red and green only ${redGreen.toFixed(0)} apart`);

  const chrome = chromeVars(theme);
  const ui: [string, string, string, number][] = [
    ['ui text', chrome['--fg'], chrome['--bg-raised'], 4.5],
    ['dim ui text', chrome['--fg-dim'], chrome['--bg'], 3],
    ['button text', chrome['--accent-fg'], chrome['--accent-bg'], 4.5],
    ['input text', chrome['--fg'], chrome['--bg-input'], 4.5],
  ];
  for (const [what, fg, bg, min] of ui) {
    const ratio = contrast(fg, bg);
    if (ratio < min) problems.push(`${what} ${ratio.toFixed(1)}:1 (want ${min}:1)`);
  }

  return { body, minAnsi: dimmest.ratio, minAnsiName: dimmest.name, redGreen, problems };
}
