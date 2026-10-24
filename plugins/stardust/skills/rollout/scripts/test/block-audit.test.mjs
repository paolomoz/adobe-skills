#!/usr/bin/env node
// Contract test for rollout/scripts/block-audit.mjs (#142): cell roles and content models from DA
// documents, CSS evidence (selector lists split outside parentheses, variant names normalised),
// scope tokens, families → PROMOTE, near-identical sheets → MERGE, unit-led names → RENAME, the
// request cost of a variant host, and a CLI run over a fixture project (--no-decorate: no DOM).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  cellRoles, blockInstances, instanceModel, splitSelectors, cssEvidence, scopeTokens, recommend, requestCost, jaccard,
} from '../block-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'block-audit.mjs');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`); } };

const doc = (blocks) => `<body><header></header><main><div>${blocks}</div></main><footer></footer></body>`;
const card = '<div><div><picture><img src="x"></picture></div><div><h3>T</h3><p>a</p><p>b</p><p><strong><a href="/x">Go</a></strong></p></div></div>';

check('cell roles: heading, paragraphs collapsed, CTA, image, key cell', () => {
  assert.equal(cellRoles('<h3>T</h3><p>a</p><p>b</p><p><a href="/x">Go</a></p>'), 'H.P+.CTA');
  assert.equal(cellRoles('<p><picture><img src="x"></picture></p>'), 'IMG');
  assert.equal(cellRoles(''), '∅');
  assert.equal(cellRoles('<p>Field</p>', { firstCell: true }), 'KEY');
});

check('instances and models: repeated rows collapse, tokens per column', () => {
  const [i] = blockInstances(doc(`<div class="cards dark wide">${card}${card}${card}</div><div class="metadata"><div><div>a</div></div></div>`));
  assert.deepEqual([i.block, i.classes], ['cards', ['dark', 'wide']]);
  const m = instanceModel(i.rows);
  assert.equal(m.cols, 2);
  assert.equal(m.shape, '(IMG | H.P+.CTA)*');
  assert.ok(m.tokens.has('c1:CTA') && m.tokens.has('c0:IMG'));
});

check('css: selector lists split outside :is()/:where(), block and variant normalised, unscoped counted', () => {
  assert.deepEqual(splitSelectors(':where(.a.b) :is(h2, h3), .c'), [':where(.a.b) :is(h2, h3)', '.c']);
  const a = cssEvidence('.cards.dark .x { color: red } @media (width >= 900px) { .cards.dark .x { color: blue } } body .y { margin: 0 }', { block: 'cards', variant: 'dark' });
  const b = cssEvidence('.cards.light .x { color: red } @media (width >= 900px) { .cards.light .x { color: blue } }', { block: 'cards', variant: 'light' });
  assert.equal(a.unscoped, 1);
  assert.equal(jaccard(a.tokens, b.tokens), 2 / 3);
});

check('scope tokens: a lead word in ≥ 3 blocks or with a digit', () => {
  const t = scopeTokens([['hero', ['home-hero', 'u1-dark']], ['cards', ['home-steps']], ['logos', ['home-brands', 'dark']]]);
  assert.ok(t.has('home') && t.has('u1') && !t.has('dark'));
});

check('recommend: other model → PROMOTE, near-identical sheets → MERGE, scope-led name → RENAME', () => {
  const tok = (...xs) => new Set(xs);
  const v = (name, instances, cols, model, css, extra = {}) => ({ name, instances, model: { cols, shape: `s${cols}`, tokens: tok(...model) }, skeleton: { error: 'n/a' }, css: { tokens: tok(...css) }, extends: [], ...extra });
  const out = recommend('promo', [
    v('dark', 9, 1, ['c0:H', 'c0:P', 'c0:CTA'], ['a', 'b', 'c', 'd']),
    v('u1-dark', 2, 1, ['c0:H', 'c0:P', 'c0:CTA'], ['a', 'b', 'c', 'd']),
    v('home-light', 1, 1, ['c0:H', 'c0:CTA'], ['x']),
    v('search', 3, 2, ['c0:KEY', 'c1:P'], ['s']),
  ], { scope: new Set(['u1', 'home']) });
  assert.equal(out.actions.search.action, 'PROMOTE');
  assert.deepEqual([out.actions['u1-dark'].action, out.actions['u1-dark'].into], ['MERGE', 'dark']);
  assert.equal(out.actions['home-light'].action, 'RENAME');
  assert.equal(out.actions.dark.action, 'KEEP');
  assert.equal(out.families.length, 2);
});

check('recommend: a data table whose column count varies is compared column-free (no PROMOTE for a wider table)', () => {
  const v = (name, cols, colsVary, tokens) => ({ name, instances: 2, model: { cols, colsVary, shape: 'x', tokens: new Set(tokens) }, skeleton: { error: 'n/a' }, css: { tokens: new Set([name]) }, extends: [] });
  const out = recommend('table', [v('data', 3, true, ['cols:3', 'c0:P', 'c1:P', 'c2:P']), v('wide', 4, false, ['cols:4', 'c0:P', 'c1:P', 'c2:P', 'c3:P'])]);
  assert.equal(out.families.length, 1);
});

check('request cost: a variant host adds 2 per distinct look and its chain; standard is 2 per block', () => {
  const page = [{ block: 'hero', classes: ['a'] }, { block: 'hero', classes: ['a'] }, { block: 'cards', classes: ['b'] }];
  assert.deepEqual(requestCost(page, new Set(['hero', 'cards']), (b, x) => (x === 'b' ? ['base'] : [])), { now: 10, standard: 4 });
});

check('CLI: --help writes nothing; a fixture project yields the JSON report and the summary line', () => {
  const proj = mkdtempSync(join(tmpdir(), 'block-audit-'));
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd: proj, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /MERGE \/ PROMOTE \/ RENAME \/ KEEP/);
  mkdirSync(join(proj, 'content'), { recursive: true });
  mkdirSync(join(proj, 'blocks', 'cards', 'variants'), { recursive: true });
  writeFileSync(join(proj, 'blocks', 'cards', 'cards.js'), "export default async function d(b) { await import(`/blocks/cards/variants/${b.classList[1]}.js`); }\n");
  writeFileSync(join(proj, 'blocks', 'cards', 'variants', 'u1-dark.css'), '.cards.u1-dark .x { color: red }\n');
  writeFileSync(join(proj, 'blocks', 'cards', 'variants', 'u2-dark.css'), '.cards.u2-dark .x { color: red }\n');
  writeFileSync(join(proj, 'content', 'a.html'), doc(`<div class="cards u1-dark">${card}</div>`));
  writeFileSync(join(proj, 'content', 'b.html'), doc(`<div class="cards u2-dark">${card}</div>`));
  const r = spawnSync(process.execPath, [SCRIPT, '--no-decorate', '--json', 'out.json'], { cwd: proj, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /block-audit: 1 blocks, 2 variants — merge 1 · promote 0 · rename 1 · keep 0; requests\/page 4 → 2/);
  const rep = JSON.parse(readFileSync(join(proj, 'out.json'), 'utf8'));
  assert.equal(rep.blocks[0].variantHost, true);
});

console.log(failed ? `block-audit: ${failed} check(s) failed` : 'block-audit: all checks passed');
process.exit(failed ? 1 : 0);
