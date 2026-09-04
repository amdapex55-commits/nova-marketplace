/* Guards against the collision that cost real time: a bare single-class rule in
 * motion.css whose name is also used by the app's own stylesheets.
 *
 * `.ghost` for the skeleton cards matched every `.btn.ghost` secondary button
 * and gave them position:absolute and opacity:.5 — a half-transparent sheet
 * over the whole page, on every screen, for a while before anyone looked.
 *
 *   node scripts/lint-css.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public', 'css');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

const classesIn = src =>
  new Set([...strip(src).matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

/* Selectors that are a single bare class and nothing else — the ones that will
   match anywhere in the document. */
const bareClasses = src => {
  const out = new Set();
  // match[1] is the (^|}) boundary; the selector is match[2].
  for (const [, , selector] of strip(src).matchAll(/(^|})([^{}@]+)\{/g)) {
    for (const part of selector.split(',')) {
      const m = part.trim().match(/^\.([a-zA-Z][\w-]*)$/);
      if (m) out.add(m[1]);
    }
  }
  return out;
};

const motion = await fs.readFile(path.join(ROOT, 'motion.css'), 'utf8');
const others = (await Promise.all(
  (await fs.readdir(ROOT))
    .filter(f => f.endsWith('.css') && f !== 'motion.css')
    .map(f => fs.readFile(path.join(ROOT, f), 'utf8'))
)).join('\n');

const clashes = [...bareClasses(motion)].filter(c => classesIn(others).has(c));

if (clashes.length) {
  console.error(
    'motion.css defines bare single-class rules whose names the app already uses:\n' +
    clashes.map(c => `  .${c}`).join('\n') +
    '\n\nThese match every element with that class anywhere. Qualify the selector' +
    '\n(.deck .thing) or rename it (.thing-card).');
  process.exit(1);
}
console.log(`css ok — ${bareClasses(motion).size} bare motion classes, none clashing`);
