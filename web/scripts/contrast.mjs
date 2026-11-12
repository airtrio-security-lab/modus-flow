/**
 * Checks the colour tokens in src/styles.css against WCAG contrast thresholds,
 * for the light theme and the dark theme. Exits non-zero on the first failure.
 *   node scripts/contrast.mjs
 */
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const block = (re) => {
  const m = css.match(re);
  if (!m) throw new Error(`token block not found: ${re}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]]));
};
const light = block(/:root \{([\s\S]*?)\n\}/);
const dark = { ...light, ...block(/:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/) };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum]: text 4.5, non-text boundaries 3.
const PAIRS = [
  ['ink', 'paper', 4.5], ['ink', 'surface', 4.5], ['ink-2', 'paper', 4.5], ['ink-2', 'surface', 4.5], ['ink-2', 'column', 4.5],
  ['ink-3', 'paper', 4.5], ['ink-3', 'surface', 4.5], ['ink-3', 'column', 4.5],
  ['accent-ink', 'surface', 4.5], ['accent-ink', 'accent-tint', 4.5], ['on-accent', 'accent', 4.5], ['on-ink', 'ink', 4.5],
  ['amber', 'paper', 4.5], ['amber', 'amber-tint', 4.5], ['on-signal', 'amber', 4.5],
  ['red', 'surface', 4.5], ['red', 'red-tint', 4.5], ['green', 'surface', 4.5],
  ['field-border', 'surface', 3],
];
let failed = 0;
for (const [name, t] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg, min] of PAIRS) {
    const r = ratio(t[fg], t[bg]);
    if (r < min) {
      failed++;
      console.error(`✗ ${name}: --${fg} on --${bg} = ${r.toFixed(2)} < ${min}`);
    }
  }
}
if (failed) process.exit(1);
console.log(`✓ contrast: ${PAIRS.length * 2} token pairs pass (light and dark)`);
