#!/usr/bin/env node
// skills/deploy/scripts/test/css-coverage.test.mjs — the pure half of css-coverage (#142b): span-preserving scan,
// selector relaxation (states, :not, attributes, runtime classes), JS class tokens, prune (dead selectors, empty
// groups, duplicate declarations, an earlier rule a later identical one overrides), quantiles. No browser.
// Run: node plugins/stardust/skills/deploy/scripts/test/css-coverage.test.mjs
import assert from 'node:assert/strict';
import {
  scanCss, splitTop, relaxSelector, jsClassTokens, dynamicPredicate, pruneCss, cssRules, parseDecls, quantile,
} from '../css-coverage.mjs';

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`); } };

check('scanCss: rules, groups with children, statements; braces in strings and comments ignored', () => {
  const t = '@import url(x.css);\n/* a { b } */\n.a::before { content: "}{"; }\n@media (width <= 600px) { .b { color: red; } }\n@keyframes k { from { opacity: 0; } }\n';
  const n = scanCss(t);
  assert.deepEqual(n.map((x) => x.type), ['stmt', 'rule', 'at', 'at']);
  assert.equal(n[1].head, '.a::before');
  assert.equal(n[2].children.length, 1);
  assert.equal(n[3].children, undefined, 'keyframes are opaque');
  assert.deepEqual(cssRules(t).map((r) => [r.sels, r.ctx]), [[['.a::before'], ''], [['.b'], '|@media (width <= 600px)']]);
});

check('splitTop: commas inside :is() and attribute strings stay', () => {
  assert.deepEqual(splitTop('.a, :is(.b, .c) > p, [x=","] d'), ['.a', ':is(.b, .c) > p', '[x=","] d']);
});

check('parseDecls: props, values, !important, nested body → null', () => {
  const t = '{ color: red ; margin:0 !important; --X: a;b }';
  const d = parseDecls(t, 1, t.length - 1);
  assert.deepEqual(d.map((x) => [x.prop, x.value, x.important]), [['color', 'red', false], ['margin', '0', true], ['--X', 'a', false]], 'a segment without a colon is skipped');
  assert.equal(parseDecls('{ a { b: c } }', 1, 13), null);
});

check('relaxSelector: states, pseudo-elements, :not, attributes and runtime classes dropped; :is/:where/:has kept', () => {
  const dyn = (c) => ['open', 'active'].includes(c);
  const cases = {
    ':where(.blk.look) .container': ':where(.blk.look) .container',
    '.a:hover > .b::before': '.a > .b',
    '.menu.open .x': '.menu .x',
    'div:not(.y) ~ .open': 'div ~ *',
    '.x:has(> .active)': '.x:has(> *)',
    'nav div:nth-child(2n+1)': 'nav div',
    'html[dir=rtl] .x::after': 'html .x',
    ':is(.a, .open) + section': ':is(.a, *) + section',
    '.md\\:flex .y': '.md\\:flex .y',
  };
  for (const [i, o] of Object.entries(cases)) assert.equal(relaxSelector(i, dyn), o, i);
});

check('jsClassTokens + dynamicPredicate: toggled, template prefix, literal absent from every snapshot', () => {
  const t = jsClassTokens("el.classList.toggle('is-open', x); a.className = `card state-${s}`; const k = 'built-on-click static';");
  assert.ok(t.toggled.has('is-open') && t.toggled.has('card'));
  assert.ok(t.prefixes.has('state-'));
  const dyn = dynamicPredicate(t, new Set(['static', 'card']));
  assert.equal(dyn('is-open'), true);
  assert.equal(dyn('state-active'), true);
  assert.equal(dyn('built-on-click'), true, 'in JS, never in a snapshot');
  assert.equal(dyn('static'), false, 'in JS and in a snapshot');
  assert.equal(dyn('lifted-only'), false, 'never in JS');
});

check('relaxSelector: an authored element is any element; a class set next to a free ${…} frees its compound', () => {
  const t = jsClassTokens('dd.className = `menu-dd ${key} menu-dd-open`;');
  assert.ok(t.anchors.has('menu-dd'));
  const dyn = dynamicPredicate(t, new Set(['menu-dd']));
  assert.equal(relaxSelector('.header .menu-dd.platform', dyn), '.header *');
  assert.equal(relaxSelector('.doc .md a:hover', dyn), '.doc .md *');
  assert.equal(relaxSelector('.page-head p:empty', dyn), '.page-head *');
  assert.equal(relaxSelector('.wrap > div.card', dyn), '.wrap > div.card', 'a decorate-built element stays strict');
});

check('pruneCss: dead selectors and rules go, empty groups go, at-rules without children stay', () => {
  const t = '.a, .dead { color: red; }\n\n.gone { color: blue; }\n\n@media (width <= 600px) {\n  .gone2 { color: red; }\n}\n\n@keyframes k { from { opacity: 0; } }\n';
  const sels = cssRules(t).map((r) => r.sels);
  const res = pruneCss(t, (i, j) => !/dead|gone/.test(sels[i][j]));
  assert.equal(res.text, '.a { color: red; }\n\n@keyframes k { from { opacity: 0; } }\n');
  assert.equal(res.stats.deadRules, 2); assert.equal(res.stats.deadSelectors, 3); assert.equal(res.stats.groups, 1);
  assert.deepEqual(res.removed, ['.dead', '.gone', '.gone2']);
});

check('pruneCss: an exact duplicate declaration and an earlier rule a later identical one overrides go; fallbacks stay', () => {
  const t = '.a { color: red; color: red; display: -webkit-box; display: flex; }\n.b { margin: 0; }\n.c { margin: 0; }\n.b { margin: 0; padding: 1px; }\n@media print { .b { margin: 0; } }\n.d { color: red !important; }\n.d { color: red; }\n';
  const res = pruneCss(t, () => true);
  assert.equal(res.stats.dupDecls, 1);
  assert.equal(res.stats.overridden, 1, 'only the first .b — the print one differs in condition, the .d pair in importance');
  assert.ok(res.text.includes('display: -webkit-box; display: flex;'));
  assert.equal((res.text.match(/^\.b \{/gm) || []).length, 1);
  assert.equal((res.text.match(/\.d \{/g) || []).length, 2);
});

check('quantile: median and p90 of a list', () => {
  assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(quantile([], 0.5), 0);
});

process.exit(failed ? 1 : 0);
