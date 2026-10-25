#!/usr/bin/env node
// skills/replica/scripts/test/drift.test.mjs — drift.mjs (#146), pure, no browser: args per mode, the offset steps
// (text-matched in order, the element before a step as the cause), the pixel-only row test, and the override plan
// (pixel-only rows written with the measured steps; other criteria, pct over the cap, an unmeasured row and a
// cause repeating on many rows without a named decision refused). Run: node <this file>.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { causeText, driftSteps, parseArgs, pixelOnly, planOverrides } from '../drift.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'drift.mjs');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); } };

check('--help exits 0 and writes nothing; usage errors exit 2', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'drift-help-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--overrides/); assert.match(r.stdout, /--decision/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'https://a.test'], { cwd, encoding: 'utf8' }).status, 2);
  assert.deepEqual(readdirSync(cwd), []);
  rmSync(cwd, { recursive: true, force: true });
});

check('parseArgs: modes, the served selector defaults to the origin one, a value flag never swallows a flag', () => {
  const p = parseArgs(['https://o.test/a', 'https://s.test/a', '--origin-sel', '.post .body', '--served-sel', 'main .body']);
  assert.equal(p.mode, 'page'); assert.equal(p['served-sel'], 'main .body');
  assert.equal(parseArgs(['--pages', 'p.json', '--out', 'o.json', '--origin-sel', '.b']).mode, 'screen');
  const v = parseArgs(['--overrides', 'run.json', '--gate-dir', 'g', '--origin-sel', '.b']); assert.equal(v.mode, 'overrides'); assert.equal(v['served-sel'], '.b');
  assert.throws(() => parseArgs(['a', 'b']), /--origin-sel/); assert.throws(() => parseArgs(['--pages', 'p', '--origin-sel', '.b']), /--out/);
  assert.throws(() => parseArgs(['a', 'b', '--origin-sel', '--json']), /needs a value/);
});

const el = (y, h, t, tag = 'p') => ({ y, h, t, tag });
check('driftSteps: a spacing difference after one element is a step naming it; short texts and unmatched elements skipped', () => {
  const o = [el(0, 40, 'Introduction to the topic here'), el(60, 30, 'A heading with a margin', 'h3'), el(130, 50, 'Paragraph after the heading'), el(200, 20, 'tiny'), el(250, 50, 'Closing paragraph of the body')];
  const s = [el(0, 40, 'Introduction to the topic here'), el(60, 30, 'A heading with a margin', 'h3'), el(154, 50, 'Paragraph after the heading'), el(260, 20, 'Only on the served side x'), el(274, 50, 'Closing paragraph of the body')];
  const d = driftSteps(o, s, { min: 10 });
  assert.equal(d.matched, 4); assert.equal(d.finalOffset, 24); assert.equal(d.steps.length, 1);
  assert.deepEqual(d.steps[0], { at: 'Paragraph after the heading', delta: 24, offset: 24, cause: { tag: 'h3', h: [30, 30], t: 'A heading with a margin' } });
  assert.equal(causeText(d.steps[0]), '+24 px after h3 (30 px origin / 30 px served) "A heading with a margin"');
});

const row = (slug, extra = {}) => ({ slug, pass: false, passWithOverride: false, pixelPass: false, heightPass: true, clipPass: true, contentPass: true, unitPass: null, pct: 14, heightDelta: -12, reasons: ['pixel 14% > 10%'], ...extra });
const step = (tag) => ({ at: 'x', delta: 20, offset: 20, cause: { tag, h: [30, 30], t: 'h' } });
check('pixelOnly + planOverrides: pixel-only rows get the measured drift; other criteria, the cap, unmeasured and repeating causes are refused', () => {
  assert.equal(pixelOnly(row('a')), true); assert.equal(pixelOnly(row('b', { contentPass: false })), false); assert.equal(pixelOnly(row('c', { pass: true })), false);
  const rows = [row('a'), row('b', { contentPass: false, reasons: ['content MISSING 1 / HIDDEN 0'] }), row('c', { pct: 31 }), row('d'), row('e'), row('f'), row('ok', { pass: true })];
  const drifts = { a: { steps: [step('h3')], docH: [5000, 4990], finalOffset: 20 }, d: { error: 'timeout' }, e: { steps: [], docH: [1, 1], finalOffset: 6 }, f: { steps: [step('h3')], docH: [1, 1], finalOffset: 20 } };
  const p = planOverrides(rows, drifts, { width: 360, maxPct: 20, repeat: 5 });
  assert.deepEqual(Object.keys(p.write).sort(), ['a', 'e', 'f']);
  assert.match(p.write.a.reason, /Measured drift @360: \+20 px after h3/); assert.deepEqual(p.write.a.drift.steps, [step('h3')]);
  assert.match(p.write.e.reason, /line-wrap drift only \(final offset 6 px\)/);
  assert.deepEqual(p.refused.map((r) => r.slug), ['b', 'c', 'd']);
  const many = Array.from({ length: 5 }, (_, i) => row(`p${i}`)); const md = Object.fromEntries(many.map((r) => [r.slug, { steps: [step('h3')], docH: [1, 1], finalOffset: 20 }]));
  assert.equal(planOverrides(many, md, { width: 360, repeat: 5 }).refused.length, 5);
  const kept = planOverrides(many, md, { width: 360, repeat: 5, decision: 'R-NO-LENGTHS' });
  assert.equal(Object.keys(kept.write).length, 5); assert.match(kept.write.p0.reason, /cause shared by 5 rows, kept by R-NO-LENGTHS/);
});

console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exit(failed ? 1 : 0);
