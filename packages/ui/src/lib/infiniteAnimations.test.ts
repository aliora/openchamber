import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An infinite CSS animation draws every frame for as long as it is on screen,
 * which is what kept an idle app busy (see the `theme-system` skill, "Animation
 * Contract"). A wait that can last shows `Spinner` (`components/ui/spinner.tsx`),
 * `BusyDots` or `useWaitingBlink`, all on one shared clock. The infinite CSS
 * animations left are bounded by the user: the short `animate-spin` of a button
 * or a quick load, the diff's expand spinner, the model name that scrolls while
 * hovered. A new one fails here until it is replaced or listed with a reason.
 */
const ALLOWED = [
  { file: 'index.css', declaration: 'animation: webkit-spin 1s linear infinite !important;' },
  { file: 'index.css', declaration: 'animation: oc-trailing-expand-spin 0.8s linear infinite;' },
  { file: 'index.css', declaration: 'animation: marquee-scroll 5s linear infinite alternate;' },
  { file: 'components/views/PierreDiffViewer.tsx', declaration: 'animation: oc-expand-spin 0.8s linear infinite;' },
  // The fork's working indicators and status logo: shown only while a turn
  // runs, stepped so they draw a few frames a second. Moving them onto the
  // shared clock is open work.
  { file: 'index.css', declaration: 'animation: oc-status-logo 4s steps(10, jump-none) infinite;' },
  { file: 'index.css', declaration: 'animation: oc-working-sweep var(--oc-working-sweep) steps(40, jump-none) infinite;' },
  { file: 'index.css', declaration: 'animation: oc-working-glow 3.4s steps(34, jump-none) infinite;' },
  { file: 'index.css', declaration: 'animation: oc-working-breathe 3.4s steps(34, jump-none) infinite;' },
  { file: 'index.css', declaration: 'animation: oc-working-spin 2s steps(30) infinite;' },
  { file: 'index.css', declaration: 'animation: oc-working-twinkle 2.4s steps(24, jump-none) infinite;' },
  { file: 'index.css', declaration: 'animation: oc-working-sparkle 2.4s steps(24, jump-none) infinite;' },
];

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INFINITE_DECLARATION = /animation(?:-iteration-count)?\s*:[^;\n]*\binfinite\b[^;\n]*;?/g;
const PULSE_CLASS = /\banimate-(?:pulse|ping|bounce)\b|\banimate-\[[^\]]*\]/g;

const sourceFiles = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => /\.(css|tsx?)$/.test(file) && !/\.test\.|__tests__\//.test(file));

test('no infinite CSS animation outside the short, user-bounded ones', () => {
  const found: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(join(SOURCE_ROOT, file), 'utf8');
    for (const match of text.matchAll(INFINITE_DECLARATION)) {
      const declaration = match[0].trim();
      if (!ALLOWED.some((entry) => entry.file === file && entry.declaration === declaration)) {
        found.push(`${file}: ${declaration}`);
      }
    }
    if (!file.endsWith('.css')) {
      for (const match of text.matchAll(PULSE_CLASS)) found.push(`${file}: ${match[0]}`);
    }
  }
  expect(found).toEqual([]);
});

test('every allowed infinite animation still exists', () => {
  for (const entry of ALLOWED) {
    expect(readFileSync(join(SOURCE_ROOT, entry.file), 'utf8')).toContain(entry.declaration);
  }
});
