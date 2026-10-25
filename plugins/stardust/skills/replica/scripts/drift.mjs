#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop, max-len */
/**
 * replica/drift.mjs — where a served page drifts vertically from the origin, and by how much (#146; the rule:
 * source-fidelity-gate.md § The all-pages published-origin gate, "Pixel-only failures").
 *
 * The children of the body container on both sides (`<sel> > *`) are matched by their text (first 40 chars,
 * whitespace folded) in document order; each match gives an offset (served y − origin y). A STEP is a change of
 * offset beyond --min px: the element BEFORE it is the cause (its height on both sides is printed). The pixel %
 * of a text-dense page is offset-sensitive — one spacing difference near the top moves every later line — so a
 * pixel-only failure is read beside its measured drift, never alone.
 *
 * Usage:
 *   node drift.mjs <origin-url> <served-url> --origin-sel <sel> [--served-sel <sel>] [--width 360] [--min 10] [--json]
 *   node drift.mjs --pages <pages.json> --out <screen.json> --origin-sel <sel> [--served-sel …] [--width] [--concurrency 4]
 *        the pre-gate screen: pages.json = [{ slug, origin, served }]; per page docH both sides + steps
 *   node drift.mjs --overrides <run.json|summary.json> --gate-dir <gates/all-<w>> --origin-sel <sel> [--served-sel …]
 *        [--width] [--max-pct 20] [--repeat 5] [--decision <id>] [--by <who>] [--dry-run]
 *        writes <gate-dir>/overrides.json for rows failing on PIXEL ONLY (content, clip, height, units pass) with the
 *        measured steps in the reason; URLs from <gate-dir>/<slug>/{origin,eds}.json. Refused: any other failing
 *        criterion, pct > --max-pct, and a cause (the element signature before the first step) shared by
 *        ≥ --repeat rows unless --decision names the logged decision that keeps it a residual.
 *   --consent <sel> / --dismiss <sel,…>  controls clicked on both sides before measuring.
 * Exit: 0 ok, 2 usage or (overrides) any row refused, 1 error. Requires playwright (the project's).
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VALUE = ['origin-sel', 'served-sel', 'width', 'min', 'pages', 'out', 'concurrency', 'overrides', 'gate-dir', 'max-pct', 'repeat', 'decision', 'by', 'consent', 'dismiss'];
export function parseArgs(argv) {
  const o = { width: '360', min: '10', concurrency: '4', 'max-pct': '20', repeat: '5', by: 'drift.mjs', pos: [], json: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true; else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!VALUE.includes(k)) throw new Error(`unknown option ${a}`);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      o[k] = argv[i + 1]; i += 1;
    } else o.pos.push(a);
  }
  if (!o['origin-sel']) throw new Error('--origin-sel <body container> is required');
  o['served-sel'] = o['served-sel'] || o['origin-sel'];
  o.mode = o.overrides ? 'overrides' : o.pages ? 'screen' : 'page';
  if (o.mode === 'page' && o.pos.length !== 2) throw new Error('give <origin-url> <served-url>, or --pages, or --overrides');
  if (o.mode === 'screen' && !o.out) throw new Error('--pages needs --out <screen.json>');
  if (o.mode === 'overrides' && !o['gate-dir']) throw new Error('--overrides needs --gate-dir <gates/all-<w>>');
  return o;
}

const key = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 40);
/** Steps of the offset between two element lists [{ y, h, tag, t }] (matched by text, in order). */
export function driftSteps(origin, served, { min = 10 } = {}) {
  const steps = []; let prev = 0; let j = 0; let last = null; let matched = 0;
  for (const x of origin) {
    if (key(x.t).length < 8) continue;
    const k = served.findIndex((z, i) => i >= j && key(z.t) === key(x.t));
    if (k < 0) continue;
    j = k + 1; matched += 1;
    const d = served[k].y - x.y;
    if (Math.abs(d - prev) > min) steps.push({ at: key(x.t), delta: d - prev, offset: d, cause: last ? { tag: last.o.tag, h: [last.o.h, last.s.h], t: key(last.o.t) } : null });
    prev = d; last = { o: x, s: served[k] };
  }
  return { steps, matched, finalOffset: prev };
}
export const causeText = (s) => `${s.delta > 0 ? '+' : ''}${s.delta} px after ${s.cause ? `${s.cause.tag} (${s.cause.h[0]} px origin / ${s.cause.h[1]} px served) "${s.cause.t}"` : 'the top'}`;

/** A gate row failing on the pixel criterion only (gate-all's verdict fields). */
export const pixelOnly = (r) => !r.pass && r.pixelPass === false && r.heightPass !== false && r.clipPass !== false && r.contentPass !== false && r.unitPass !== false;

/** The override decisions for failing rows: { write: { slug: entry }, refused: [{ slug, why }] }. drifts: slug → drift result. */
export function planOverrides(rows, drifts, { width, maxPct = 20, repeat = 5, decision = null, by = 'drift.mjs' } = {}) {
  const write = {}; const refused = []; const groups = {};
  const failing = rows.filter((r) => !r.pass && !r.passWithOverride);
  for (const r of failing) { const d = drifts[r.slug]; const c = d && d.steps && d.steps[0] && d.steps[0].cause; if (c) (groups[c.tag] = groups[c.tag] || []).push(r.slug); }
  for (const r of failing) {
    if (!pixelOnly(r)) { refused.push({ slug: r.slug, why: `not pixel-only: ${(r.reasons || []).join('; ')}` }); continue; }
    if (r.pct > maxPct) { refused.push({ slug: r.slug, why: `pixel ${r.pct}% > --max-pct ${maxPct}` }); continue; }
    const d = drifts[r.slug];
    if (!d || d.error) { refused.push({ slug: r.slug, why: `drift not measured${d && d.error ? ` (${d.error})` : ''}` }); continue; }
    const first = d.steps[0] && d.steps[0].cause;
    const n = first ? groups[first.tag].length : 0;
    if (first && n >= repeat && !decision) { refused.push({ slug: r.slug, why: `cause ${first.tag} repeats on ${n} rows — fix it generally (CSS, encoder) and re-gate, or name the decision that keeps it a residual (--decision)` }); continue; }
    const causes = d.steps.slice(0, 3).map(causeText).join('; ') || `no step > the minimum: line-wrap drift only (final offset ${d.finalOffset} px)`;
    write[r.slug] = {
      verdict: 'PASS (documented residual — measured drift)', by,
      reason: `pixel ${r.pct}% is the only failing criterion (content, clip, height${r.unitPass != null ? ', units' : ''} pass; Δh ${r.heightDelta} px). Measured drift @${width}: ${causes}${n >= repeat ? ` — cause shared by ${n} rows, kept by ${decision}` : ''}. Valid only while pixel is the sole failing criterion.`,
      drift: { width: Number(width), docH: d.docH, steps: d.steps.slice(0, 3) },
    };
  }
  return { write, refused };
}

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; } catch { /* the project */ }
  const req = createRequire(join(process.cwd(), 'package.json'));
  return (await import(pathToFileURL(req.resolve('playwright')).href)).chromium;
}
async function measure(browser, url, sel, o) {
  const ctx = await browser.newContext({ viewport: { width: Number(o.width), height: 900 } });
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: 'load', timeout: 90000 });
    for (const c of [o.consent, ...String(o.dismiss || '').split(',')].filter(Boolean)) await p.click(c, { timeout: 2500 }).catch(() => {});
    await p.waitForTimeout(1500);
    await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => { setTimeout(r, 100); }); } window.scrollTo(0, 0); });
    await p.waitForTimeout(1200);
    return await p.evaluate((s) => ({ docH: document.documentElement.scrollHeight, els: [...document.querySelectorAll(`${s} > *`)].map((n) => { const q = n.getBoundingClientRect(); return { y: Math.round(q.top + window.scrollY), h: Math.round(q.height), tag: `${n.tagName.toLowerCase()}${n.classList[0] ? `.${n.classList[0]}` : ''}`, t: n.textContent }; }) }), sel);
  } finally { await ctx.close(); }
}
async function driftOf(browser, origin, served, o) {
  const [a, b] = await Promise.all([measure(browser, origin, o['origin-sel'], o), measure(browser, served, o['served-sel'], o)]);
  if (!a.els.length || !b.els.length) return { error: `body container matched nothing (${a.els.length} origin / ${b.els.length} served children)`, docH: [a.docH, b.docH] };
  return { ...driftSteps(a.els, b.els, { min: Number(o.min) }), docH: [a.docH, b.docH] };
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i]; i += 1; await fn(it); } })); }

export async function main(argv) {
  const o = parseArgs(argv);
  const browser = await (await loadPlaywright()).launch();
  try {
    if (o.mode === 'page') {
      const d = await driftOf(browser, o.pos[0], o.pos[1], o);
      if (o.json) console.log(JSON.stringify(d));
      else { console.log(`drift @${o.width}: docH origin ${d.docH[0]} / served ${d.docH[1]}${d.error ? ` — ${d.error}` : ` · ${d.matched} matched · final offset ${d.finalOffset} px`}`); (d.steps || []).forEach((s) => console.log(`  ${causeText(s)} → offset ${s.offset} before "${s.at}"`)); }
      return d.error ? 1 : 0;
    }
    if (o.mode === 'screen') {
      const pages = JSON.parse(readFileSync(o.pages, 'utf8')); const res = {};
      await pool(pages, Number(o.concurrency), async (pg) => {
        try { res[pg.slug] = await driftOf(browser, pg.origin, pg.served, o); } catch (e) { res[pg.slug] = { error: e.message.split('\n')[0] }; }
        const d = res[pg.slug];
        console.log(`${pg.slug}\t${d.error ? `ERROR ${d.error}` : `docH ${d.docH[0]}/${d.docH[1]}\tsteps ${d.steps.length}\tfinal ${d.finalOffset}${d.steps[0] ? `\tfirst ${causeText(d.steps[0])}` : ''}`}`);
      });
      writeFileSync(o.out, `${JSON.stringify(res, null, 1)}\n`);
      return 0;
    }
    const run = JSON.parse(readFileSync(o.overrides, 'utf8')); const rows = run.rows || [];
    const urlOf = (slug, side) => { const f = join(o['gate-dir'], slug, `${side}.json`); try { return JSON.parse(readFileSync(f, 'utf8')).url || null; } catch { return null; } };
    const drifts = {};
    await pool(rows.filter((r) => !r.pass && !r.passWithOverride && pixelOnly(r)), Number(o.concurrency), async (r) => {
      const a = urlOf(r.slug, 'origin'); const b = urlOf(r.slug, 'eds');
      if (!a || !b) { drifts[r.slug] = { error: `no URL in ${o['gate-dir']}/${r.slug}/{origin,eds}.json` }; return; }
      try { drifts[r.slug] = await driftOf(browser, a, b, o); } catch (e) { drifts[r.slug] = { error: e.message.split('\n')[0] }; }
    });
    const { write, refused } = planOverrides(rows, drifts, { width: o.width, maxPct: Number(o['max-pct']), repeat: Number(o.repeat), decision: o.decision, by: o.by });
    const file = join(o['gate-dir'], 'overrides.json');
    if (!o.dryRun && Object.keys(write).length) writeFileSync(file, `${JSON.stringify({ ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}), ...write }, null, 1)}\n`);
    console.log(`drift overrides: ${Object.keys(write).length} written${o.dryRun ? ' (dry run)' : ` → ${file}`}, ${refused.length} refused`);
    Object.entries(write).forEach(([s, e]) => console.log(`  + ${s}: ${e.drift.steps.map(causeText).join('; ') || 'line-wrap drift only'}`));
    refused.forEach((r) => console.log(`  ! ${r.slug}: ${r.why}`));
    return refused.length ? 2 : 0;
  } finally { await browser.close(); }
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim()); process.exit(0); }
  try { parseArgs(argv); } catch (e) { console.error(`drift: ${e.message}`); process.exit(2); }
  main(argv).then((c) => process.exit(c), (e) => { console.error(`drift: ${e.message}`); process.exit(1); });
}
