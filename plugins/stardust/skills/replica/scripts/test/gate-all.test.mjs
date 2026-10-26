#!/usr/bin/env node
// skills/replica/scripts/test/gate-all.test.mjs — the gate-all.mjs verdict (#125 D0), no browser: the four
// criteria (pixel, height, clip + allowance, content), n/a content never fails a page, required vs advisory
// units, pixelOnlyPass vs pass (the calibration pair), reasons text, overrides shown beside the number;
// formatSummary (header, calibration line, one row per page, asymmetric-origin flag); parseArgs defaults and
// --out derived from --width; --help in an empty cwd; pixel-compare's textBoxPct over a synthetic diff. And (#141)
// the structural row (height from the probes, skeleton, no pixel criterion), totals by gate tier, the published
// selection without a state copy (deployed, or migrated with a state / coverage URL) and the delivered-document URL.
// (#147) a row spanning a host suspension is an ERROR — never PASS / FAIL, never an override pass.
// Run: node <this file>.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummary, parseArgs, plainUrl, selectPages, sidecarEntry, suspendRow, totalsOf, verdict } from '../gate-all.mjs';

// pixel-compare imports pngjs at module level (a project devDependency, absent in the plugin checkout):
// import it lazily and skip its one check where it does not resolve, like the other browser/dep-bound tests.
let textBoxPct = null;
try { ({ textBoxPct } = await import('../pixel-compare.mjs')); } catch { console.log('skip  pixel-compare textBoxPct (pngjs not importable here)'); }

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'gate-all.mjs');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); } };
const px = (pct, heightDelta, height = 10000) => ({ pct, heightDelta, compared: { width: 1440, height }, pass: pct <= 10 });
const clip = (total) => ({ counts: { total, textClipped: total, textHidden: 0, controlHidden: 0, controlClipped: 0 } });
const content = (missing, hidden, controlState = 0) => ({ totals: { missing, hidden, controlState } });

check('the recorded card page: pixel PASS, elements FAIL — pixelOnlyPass true, pass false, both reasons named', () => {
  const v = verdict({ pixel: px(6.68, 69, 29326), clip: clip(379), content: content(0, 284, 2) });
  assert.equal(v.pixelOnlyPass, true); assert.equal(v.pass, false);
  assert.match(v.reasons.join('; '), /clipped 379/); assert.match(v.reasons.join('; '), /HIDDEN 284/); assert.match(v.reasons.join('; '), /2 control state/);
});
check('a clean page passes every criterion', () => {
  const v = verdict({ pixel: px(1.77, -1, 3415), clip: clip(0), content: content(0, 0) });
  assert.equal(v.pass, true); assert.deepEqual(v.reasons, []); assert.equal(v.originH, 3415); assert.equal(v.edsH, 3416);
});
check('height guard: pixel % inside the bar but 6900 px too tall fails (the rejected union metric case)', () => {
  const v = verdict({ pixel: px(4, -6900, 10000), clip: clip(0), content: content(0, 0) });
  assert.equal(v.pixelPass, true); assert.equal(v.heightPass, false); assert.equal(v.pixelOnlyPass, false); assert.match(v.reasons[0], /Δh -6900px > 5% of 10000/);
});
check('clip allowance: a documented allowance lifts the bar; clipMax option too', () => {
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(2), content: content(0, 0), allowance: 2 }).pass, true);
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(3), content: content(0, 0), allowance: 2 }).pass, false);
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(3), content: content(0, 0) }, { clipMax: 3 }).pass, true);
});
check('content n/a (origin not probed) never fails the page and is named in the row', () => {
  const v = verdict({ pixel: px(3, 0), clip: clip(0), content: { error: 'origin HTTP 403' } });
  assert.equal(v.pass, true); assert.equal(v.contentPass, null); assert.equal(v.contentNA, 'origin HTTP 403');
  const w = verdict({ pixel: px(3, 0), clip: clip(0), content: null });
  assert.equal(w.contentNA, 'not probed');
});
check('criteria switched off read null and cannot fail; --no-probes = the pixel-only verdict', () => {
  const v = verdict({ pixel: px(3, 0), clip: clip(99), content: content(9, 9) }, { clipOn: false, contentOn: false });
  assert.equal(v.pass, true); assert.equal(v.clipPass, null); assert.equal(v.contentPass, null);
});
check('units: advisory families on a page with required ones never fail it — only requiredOff decides (#144)', () => {
  const v = { units: 6, within: 11, off: 5, hidden: 0, missing: 4, errors: 0, requiredOff: 0 };
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(0), content: content(0, 0), units: { verdict: v, required: true } }).unitPass, true);
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(0), content: content(0, 0), units: { verdict: { ...v, requiredOff: 1 }, required: true } }).pass, false);
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(0), content: content(0, 0), units: { verdict: { ...v, errors: 1, requiredErrors: 0 }, required: true } }).unitPass, true, 'an advisory family with no match');
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(0), content: content(0, 0), units: { verdict: { ...v, errors: 1, requiredErrors: 1 }, required: true } }).unitPass, false);
});
check('units: required units fail the page, advisory ones do not', () => {
  const u = { verdict: { off: 3, hidden: 1, missing: 0, errors: 0 } };
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(0), content: content(0, 0), units: { ...u, required: true } }).pass, false);
  assert.equal(verdict({ pixel: px(3, 0), clip: clip(0), content: content(0, 0), units: { ...u, required: false } }).pass, true);
});
check('missing capture / pixel error → not compared, reasons say so; override shows beside, never replaces', () => {
  const v = verdict({ pixel: { error: 'missing capture' }, override: { verdict: 'PASS (source capture)', reason: 'live drifted' } });
  assert.equal(v.pass, false); assert.equal(v.passWithOverride, true); assert.match(v.reasons[0], /missing capture/);
});
check('formatSummary: header, calibration line, rows, asymmetric flag, override text', () => {
  const rows = [
    { slug: 'a', path: '/a', template: 't', tier: 'thin', origin: 'stitch-live', pct: 6.68, textPct: 12.3, heightDelta: 69, clipped: 379, clipAllowance: 0, content: { missing: 0, hidden: 284, controlState: 2 }, units: { off: 12, hidden: 2, missing: 4 }, unitsRequired: true, pass: false, pixelOnlyPass: true, reasons: ['clipped 379', 'content MISSING 0 / HIDDEN 284'], masked: false, override: null, error: null },
    { slug: 'b', path: '/b', template: 't', tier: 'thin', origin: 'crawl-fullpage', pct: 3, textPct: null, heightDelta: 0, clipped: 0, clipAllowance: 0, content: null, contentNA: 'origin HTTP 403', units: null, pass: true, pixelOnlyPass: true, reasons: [], masked: true, maskedRows: 70, maskReason: 'store notice', override: null, error: null },
    { slug: 'c', path: '/', template: 'home', tier: 'archetype', origin: 'stitch-live', pct: 37, heightDelta: 3, clipped: 0, clipAllowance: 0, content: { missing: 0, hidden: 0, controlState: 0 }, units: null, pass: false, pixelOnlyPass: false, reasons: ['pixel 37% > 10%'], masked: false, override: { verdict: 'PASS (source capture)', reason: 'live drifted since capture; 9.14% vs the gated capture' }, error: null },
  ];
  const totals = { pages: 3, pass: 1, pixelOnlyPass: 2, overridePass: 1, passWithOverrides: 2, fail: 2, error: 0, failPixel: 1, failHeight: 0, failClip: 1, failContent: 1, failUnits: 1, contentNA: 1 };
  const md = formatSummary({ _provenance: { writtenAt: 'now', breakpoint: 1440, verdict: 'V' }, totals, rows });
  assert.match(md, /\*\*1 PASS \/ 2 FAIL \/ 0 error of 3\*\*/); assert.match(md, /pixel-only verdict \(criteria 1\+2\): \*\*2 PASS\*\*; full verdict \(1–4\): \*\*1 PASS\*\*/);
  assert.match(md, /\| `\/a` \|.*FAIL \(elements\)/); assert.match(md, /6\.68 \(12\.3\)/); assert.match(md, /crawl-fullpage ⚠asym/); assert.match(md, /n\/a \(origin HTTP 403\)/); assert.match(md, /masked 70 rows: store notice/); assert.match(md, /→ PASS \(source capture\): live drifted/);
  assert.match(md, /off 12 hidden 2 missing 4 \|/);
});
check('host suspension (#147): a row spanning a gap is an ERROR naming it — not PASS, not FAIL, not an override pass', () => {
  const gap = { from: '2026-10-26T07:23:00.000Z', to: '2026-10-26T08:08:00.000Z', fromMs: 1, toMs: 2, sleptS: 2700 };
  const full = { slug: 'a', path: '/a', gateTier: 'full', ...verdict({ pixel: px(2, 0, 5000), clip: clip(0), content: content(0, 0) }), pct: 2, override: { verdict: 'PASS', reason: 'drift' } };
  const structural = { slug: 'b', path: '/b', gateTier: 'structural', ...verdict({ clip: clip(4), content: content(0, 2), structural: { originH: 5000, edsH: 5000 } }) };
  assert.equal(suspendRow(full, []), full, 'no gap: the row as measured');
  const [a, b] = [suspendRow(full, [gap]), suspendRow(structural, [gap])];
  for (const r of [a, b]) { assert.equal(r.pass, false); assert.equal(r.passWithOverride, false); assert.match(r.error, /host suspended 2700s at 2026-10-26T07:23:00.000Z mid-row — re-run/); assert.deepEqual(r.reasons, [r.error]); }
  const t = totalsOf([a, b]);
  assert.deepEqual([t.pass, t.fail, t.error, t.overridePass, t.passWithOverrides], [0, 0, 2, 0, 0]);
  const md = formatSummary({ _provenance: { writtenAt: 'now', breakpoint: 1440, verdict: 'V' }, totals: t, rows: [a, b] });
  assert.equal((md.match(/\| ERROR host suspended/g) || []).length, 2, 'both rows read ERROR, the structural one too'); assert.doesNotMatch(md, /→ PASS: drift/);
});
check('parseArgs: defaults, --out derived from --width, --no-probes drops both probe criteria', () => {
  const o = parseArgs(['node', 'x']);
  assert.equal(o.out, 'stardust/replica/gates/all-1440'); assert.equal(o.threshold, 10); assert.equal(o.heightTol, 0.05); assert.equal(o.clipMax, 0); assert.equal(o.clip, true);
  const p = parseArgs(['node', 'x', '--width', '360', '--no-probes', '--only', 'a,b', '--eds-host', 'https://fix-x--r--o.aem.live/']);
  assert.equal(p.out, 'stardust/replica/gates/all-360');
  const q = parseArgs(['node', 'x', '--stage', 'prototype', '--proto-base', 'http://localhost:8791/']);
  assert.equal(q.out, 'stardust/replica/gates/prototypes-1440'); assert.equal(q.content, false, 'no content-presence at the prototype stage'); assert.equal(q.clip, true); assert.equal(q.protoBase, 'http://localhost:8791'); assert.equal(p.clip, false); assert.equal(p.content, false); assert.deepEqual(p.only, ['a', 'b']); assert.equal(p.edsHost, 'https://fix-x--r--o.aem.live');
});
if (textBoxPct) check('pixel-compare textBoxPct: differing pixels counted inside the boxes only, masked rows skipped', () => {
  const w = 10; const h = 10; const data = Buffer.alloc(w * h * 4);
  const red = (x, y) => { const i = (y * w + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255; };
  red(1, 1); red(2, 1); red(8, 8);
  const masked = new Uint8Array(h); masked[1] = 0;
  const r = textBoxPct({ data }, [{ x: 0, y: 0, w: 4, h: 4 }], w, h, masked);
  assert.equal(r.boxes, 1); assert.equal(r.pixels, 16); assert.equal(r.pct, 12.5);
  masked[1] = 1;
  assert.equal(textBoxPct({ data }, [{ x: 0, y: 0, w: 4, h: 4 }], w, h, masked).pct, 0);
});
check('structural row (#141): no pixel criterion, height from docH, skeleton escalates, probe error is not measured', () => {
  const ok = verdict({ clip: clip(0), content: content(0, 0), structural: { originH: 10000, edsH: 10100, skeleton: { ok: true } } });
  assert.equal(ok.pass, true); assert.equal(ok.pixelPass, null); assert.equal(ok.pixelOnlyPass, null); assert.equal(ok.heightDelta, -100); assert.equal(ok.heightSource, 'docH');
  const tall = verdict({ clip: clip(0), content: content(0, 0), structural: { originH: 10000, edsH: 10600, skeleton: { ok: true } } });
  assert.equal(tall.pass, false); assert.match(tall.reasons[0], /Δh -600px > 5% of 10000 \(docH\)/);
  const sk = verdict({ clip: clip(0), content: content(0, 0), structural: { originH: 100, edsH: 100, skeleton: { ok: false, reason: 'new block/variant hero(dark)' } } });
  assert.equal(sk.pass, false); assert.match(sk.reasons.join(), /skeleton: new block\/variant hero\(dark\)/);
  const err = verdict({ content: { error: 'origin bot challenge' }, structural: { originH: null, edsH: 900 } });
  assert.equal(err.pass, false); assert.match(err.reasons[0], /height not measured/);
});
check('totalsOf: structural rows are gated, not errors; tier counts; formatSummary names the gate', () => {
  const rows = [
    { slug: 'a', path: '/a', gateTier: 'full', tierReason: 'archetype', pct: 2, heightDelta: 0, pixelPass: true, heightPass: true, pixelOnlyPass: true, pass: true, reasons: [] },
    { slug: 'b', path: '/b', gateTier: 'structural', tierReason: 'sibling', pct: null, originH: 900, heightDelta: 3, heightSource: 'docH', heightPass: true, pixelOnlyPass: null, pass: true, reasons: [] },
    { slug: 'c', path: '/c', gateTier: 'full', tierReason: 'sample: random', pct: 12, heightDelta: 0, pixelPass: false, heightPass: true, pixelOnlyPass: false, pass: false, reasons: ['pixel 12% > 10%'] },
    { slug: 'd', path: '/d', gateTier: 'structural', tierReason: 'sibling', pct: null, originH: null, heightPass: false, pass: false, reasons: ['height not measured (probe error)'], error: 'probe error' },
  ];
  const t = totalsOf(rows);
  assert.deepEqual([t.pages, t.pass, t.fail, t.error, t.full, t.structural, t.structuralPass, t.sampled, t.failPixel, t.failHeight], [4, 2, 1, 1, 2, 2, 1, 1, 1, 0]);
  const md = formatSummary({ _provenance: { writtenAt: 'now', breakpoint: 360, verdict: 'V' }, totals: t, rows });
  assert.match(md, /\| `\/b` \|.*\| structural \|.*\| structural \| 3 \(docH\) \|.*PASS \(structural\)/); assert.match(md, /full \(sample\)/); assert.match(md, /Tiers: \*\*2 full\*\* \(1 sampled, 0 escalated\) \/ \*\*2 structural\*\* \(1 PASS\)/);
});
check('selectPages: deployed, or migrated with a state or coverage URL — no state copy, never a page state did not migrate; templates from coverage first', () => {
  const st = [
    { slug: 'a', url: 'https://o.test/a', status: 'deployed', liveUrl: 'https://e.test/a', template: '/a' },
    { slug: 'b', url: 'https://o.test/b', status: 'migrated', template: '/b/post' },
    { slug: 'c', url: 'https://o.test/c', status: 'migrated', template: '/c' },
    { slug: 'd', url: 'https://o.test/d', status: 'approved', template: '/d' },
  ];
  const cov = [{ slug: 'b', path: '/b', templateId: 'b-post', delivery: { status: 'verified', deployedUrl: 'https://e.test/b' } }, { slug: 'c', delivery: { status: 'pending', deployedUrl: null } }, { slug: 'd', delivery: { status: 'deployed', deployedUrl: 'https://e.test/d' } }];
  const sel = selectPages(st, cov);
  assert.deepEqual(sel.map((p) => p.slug), ['a', 'b'], 'c has no delivered URL; d is not migrated in state (a redirect source the coverage still lists)');
  assert.equal(sel[1].liveUrl, 'https://e.test/b'); assert.equal(sel[1].deployedPath, '/b'); assert.deepEqual(sel[1].templates, ['b-post', '/b/post']);
});
check('selectPages --only (#146): a named slug with a deployed coverage row is gated whatever its state status; unnamed rows keep the rule', () => {
  const st = [{ slug: 'w1', url: 'https://o.test/w1', status: 'extracted' }, { slug: 'w2', url: 'https://o.test/w2', status: 'extracted' }, { slug: 'w3', url: 'https://o.test/w3', status: 'extracted' }];
  const cov = [{ slug: 'w1', delivery: { status: 'deployed', deployedUrl: 'https://e.test/w1' } }, { slug: 'w2', delivery: { status: 'content-pending', deployedUrl: null } }, { slug: 'w3', delivery: { status: 'deployed', deployedUrl: 'https://e.test/w3' } }];
  assert.deepEqual(selectPages(st, cov, ['w1', 'w2']).map((p) => p.slug), ['w1'], 'w2 is not delivered; w3 is not named');
  assert.deepEqual(selectPages(st, cov).map((p) => p.slug), []);
});
check('sidecarEntry (#146): own entry first, else the archetype\'s for a sibling, never for a unique page', () => {
  const map = { arch: { max: 2 }, own: { max: 1 } };
  assert.deepEqual(sidecarEntry(map, 'own', { role: 'sibling', archetype: 'arch' }), { entry: { max: 1 }, from: null });
  assert.deepEqual(sidecarEntry(map, 'sib', { role: 'sibling', archetype: 'arch' }), { entry: { max: 2 }, from: 'arch' });
  assert.deepEqual(sidecarEntry(map, 'u', { role: 'unique', archetype: null }), { entry: null, from: null });
  assert.deepEqual(sidecarEntry({}, 'sib', undefined), { entry: null, from: null });
});
check('plainUrl and parseArgs (#141 flags): the delivered document, --sample all turns tiers off, legacy concurrency aliases', () => {
  assert.equal(plainUrl('https://e.test/blog/x'), 'https://e.test/blog/x.plain.html'); assert.equal(plainUrl('https://e.test/'), 'https://e.test/index.plain.html');
  const o = parseArgs(['node', 'x']); assert.equal(o.tiered, true); assert.equal(o.sample, 2); assert.equal(o.seed, '1440'); assert.equal(o.concurrency, 3); assert.equal(o.retries, 4);
  const p = parseArgs(['node', 'x', '--sample', 'all', '--probe-concurrency', '4', '--consent', '.deny', '--dismiss', '#bar,#x']);
  assert.equal(p.tiered, false); assert.equal(p.concurrency, 4); assert.equal(p.consent, '.deny'); assert.deepEqual(p.dismiss, ['#bar', '#x']);
  assert.equal(parseArgs(['node', 'x', '--no-probes']).tiered, false); assert.equal(parseArgs(['node', 'x', '--stage', 'prototype']).tiered, false);
});
check('--help exits 0 in an empty cwd and writes nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-all-help-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.match(r.stdout, /Usage: node gate-all\.mjs/); assert.deepEqual(readdirSync(cwd), []);
  rmSync(cwd, { recursive: true, force: true });
});
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
