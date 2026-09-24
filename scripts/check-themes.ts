/**
 * Measure every theme for eye comfort and legibility. Run with `npm run check:themes`.
 *
 * The two goals pull against each other: body text needs enough contrast to read without
 * squinting (WCAG AA is 4.5:1), but too much contrast is what causes glare and halation
 * (white on black is 21:1). Somewhere around 5:1 to 12:1 is comfortable for hours.
 *
 * Claude Code colours its output, so this also checks that no ANSI colour is too dim to
 * read and that red and green stay far enough apart to tell a diff apart.
 */
import { THEMES, auditTheme, type Theme } from '../src/shared/themes.js';

const ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function check(theme: Theme): string[] {
  return auditTheme(theme).problems;
}

const header = ['theme', 'body', 'dim', 'red', 'green', 'r/g'];
console.log(
  `${header[0].padEnd(26)}${header[1].padStart(6)}${header[2].padStart(6)}` +
    `${header[3].padStart(6)}${header[4].padStart(7)}${header[5].padStart(6)}  status`,
);
console.log('-'.repeat(84));

let failures = 0;
for (const theme of THEMES) {
  const p = theme.palette;
  const ratios = ANSI.map((n) => contrast(p[n], p.background));
  const problems = check(theme);
  if (problems.length) failures += 1;
  console.log(
    theme.id.padEnd(26) +
      contrast(p.foreground, p.background).toFixed(1).padStart(6) +
      Math.min(...ratios).toFixed(1).padStart(6) +
      contrast(p.red, p.background).toFixed(1).padStart(6) +
      contrast(p.green, p.background).toFixed(1).padStart(7) +
      auditTheme(theme).redGreen.toFixed(0).padStart(6) +
      '  ' +
      (problems.length ? problems.join('; ') : 'ok'),
  );
}

console.log(
  `\n${THEMES.length} themes, ${failures} with problems. ` +
    'Targets: body 4.5-13:1, every ANSI colour >=3:1, red/green separation >=150.',
);
process.exit(failures ? 1 : 0);
