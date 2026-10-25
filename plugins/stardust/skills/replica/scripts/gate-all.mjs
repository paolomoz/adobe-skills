#!/usr/bin/env node
/* eslint-disable import/no-extraneous-dependencies, import/extensions, no-await-in-loop, no-restricted-syntax, brace-style, object-curly-newline, max-len, no-console, no-continue, no-nested-ternary, no-plusplus, no-underscore-dangle, object-property-newline */
/**
 * skills/replica/scripts/gate-all.mjs — the published-origin gate over EVERY deployed page (#125, D0), tiered (#141).
 *
 * THE RULE (#125): every crafted prototype and every deployed page is a row in a pixel table —
 * `<out>/summary.{json,md}` at `stardust/replica/gates/prototypes-<w>/` (--stage prototype: pages with
 * a prototypePath, build = the served prototype, origin = the archetype round's cached live.png when
 * present) and `stardust/replica/gates/all-<w>/` (--stage published, default). gate-evidence.mjs reads
 * these tables as the source of record; a page without a row is ungated.
 *
 * Published pages: state pages at `deployed`, or at `migrated` with a delivered URL (state `liveUrl`, else the
 * rollout coverage row's `delivery.deployedUrl` when it is deployed / verified) — no hand-made state copy.
 * The template for unit families is the coverage `templateId` and the state `template`, both tried.
 *
 * TIERS (#141; the rule's home: source-fidelity-gate.md § The all-pages published-origin gate; pure parts in
 * gate-tier.mjs): archetypes and unique pages get the FULL row; a sibling of an archetype whose own row passed
 * at this width, whose import-time content count passed (#140) and whose blocks keep the archetype's order gets
 * the STRUCTURAL row — content-presence, clip, units, height ratio from the probes' settled document heights —
 * and a full row when the structural row flags it or the stratified sample draws it (the siblings covering every
 * block / variant the archetype lacks, one per state variant, + --sample n by the seeded order); a sampled pixel
 * FAIL escalates every structural sibling of that archetype.
 *
 * Per full row: stitched captures of both sides (stitch-shot's captureStitched, --settle), pixel-compare, then
 * the DOM probes on ONE load per side (content-presence's inventorySide with unit-geometry's inventory on the
 * same page; clip from the served side's load). Workers keep their browsers and contexts across pages (a
 * stealth Chrome for the origin stitch and both probe sides, bundled Chromium for the served stitch — the
 * instruments of the CLI runs). The served side is shot decorated or not at all (live-session withServedRetry:
 * 429 / 5xx / undecorated → jittered back-off, then the row is an ERROR, never a FAIL). Origin: an existing
 * capture under --skip-existing, else the frozen baseline (`gates/<slug>-<w>/baseline.png`, #138) when present,
 * else a live stitch; the origin probe inventory is cached in the page dir under --skip-existing. Writes
 * <out>/<slug>/{origin,eds,diff}.png + pixel.json + clip.json [+ content.json, units.json] (the CLI shapes),
 * <out>/summary.{json,md} (rows record gateTier + tierReason; _provenance.timing has the seconds per stage);
 * --only runs write <out>/runs/<ts>-<slug>.json instead.
 *
 * VERDICT (full row): pixel % ≤ --threshold AND |Δh| ≤ --height-tol × origin height AND served clipped ≤
 * --clip-max + clip-allow.json allowance AND content MISSING + HIDDEN links / headings = 0 (n/a when the origin
 * could not be probed — never a fail) [+ required units within --unit-tol]. Structural row: the same minus
 * pixel, the height from the probes, plus the skeleton. The pixel-only verdict is recorded beside it.
 *
 * Sidecars in <out>/, each entry documented: masks.json, overrides.json, clip-allow.json, presence.json;
 * repeated units from stardust/replica/units.json (unit-geometry.mjs header).
 *
 * Requires playwright, pixelmatch, pngjs (project devDependencies); stitch-shot.mjs, pixel-compare.mjs and
 * gate-tier.mjs next to this file; the diff skill's scripts dir alongside. Exit: 0 all PASS (overrides count),
 * 2 any FAIL, 1 error. `verdict`, `formatSummary`, `parseArgs`, `selectPages`, `totalsOf`, `plainUrl` are exported.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentCountOk, indexImportCheck, parseSkeleton, planTiers, resolveRoles } from './gate-tier.mjs';

const HELP = `gate-all — published-origin gate over every deployed page: pixel + height + clip + content, tiered (#125, #141)

Usage: node gate-all.mjs [options]   (from the project root)
  --stage published|prototype  published (default): deployed / delivered pages vs their served URL → gates/all-<w>/;
                            prototype: pages with a prototypePath vs the served prototype → gates/prototypes-<w>/
  --proto-base <url>        where the prototypes dir is served (prototype stage), e.g. http://localhost:8791
  --state <file>            stardust/state.json (status deployed, or migrated with a delivered URL)
  --coverage <file>         stardust/rollout/coverage/pages.json (delivered URL + templateId per page)
  --out <dir>               stardust/replica/gates/all-<width>
  --width <px>              1440
  --only <slug,…>           subset → runs/<ts>-<slug>.json (summary.* untouched)
  --skip-existing           reuse captures (and the origin probe inventory) in the page dir
  --recapture-eds           (with --skip-existing) re-shoot eds.png only
  --recapture-origin        re-shoot origin.png (previous kept on failure)
  --eds-host <host>         gate a code branch host against the same content
  --consent <sel>           a consent control to click first, both sides (built-ins: live-session CONSENT_CANDIDATES)
  --dismiss <sel,…>         overlay controls to click, both sides (a site's sticky bar, a modal)
  --blocked <regex>         origins the edge denies → crawl shot unless --try-blocked
  --try-blocked             attempt the live stitch on --blocked origins too
  --crawl-shots <dir>       stardust/current/assets/screenshots (fallback origin PNGs)
  --concurrency <n>         3 page workers (each keeps its browsers); legacy --origin/--eds/--probe-concurrency alias it
  --sample <n|all>          2 extra full rows per archetype's siblings beyond the cover sample; all = every page full
  --seed <s>                sample order seed (default: the width) — the same seed draws the same sample
  --import-check <f|dir>    import-run --json results (the import-time content count, #140); _meta.json gatesPassed also counts
  --variance <dir>          sibling-variance JSONs (archetype + siblings[]) naming a sibling's archetype
  --retries <n>             4 served-side retries (429 / 5xx / undecorated; a 429 pauses every worker) before the row is an error
  --threshold <pct>         10     --height-tol <frac>    0.05   --clip-max <n>  0   --unit-tol <px>  4
  --no-clip | --no-content | --no-probes   drop criteria 3 / 4 / both (pixel-only verdict; every page full)
  --units <file>            repeated-unit declarations (default <out>/units.json)
  --compare-only            no captures; recompute from existing PNGs (every page full)
  --warmup <url>            origin warm-up for the probes
  --vh <px>                 stitch chunk height
  --help                    this text
Verdict = pixel % ≤ threshold AND |Δh| ≤ height-tol × origin height AND clipped ≤ clip-max(+allowance) AND content MISSING+HIDDEN = 0.
Structural row (siblings) = the same without pixel, height from the probes; its blocks keep the archetype's order and
every block / variant the archetype lacks is covered by a sampled sibling's full row.
Sidecars in <out>/: masks.json, overrides.json, clip-allow.json, presence.json, units.json (see the header).
Exit: 0 all PASS (overrides count), 2 any FAIL, 1 error.`;

export function parseArgs(argv) {
  const rest = argv.slice(2);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(HELP); process.exit(0); }
  const o = { stage: 'published', protoBase: null, state: 'stardust/state.json', coverage: 'stardust/rollout/coverage/pages.json', out: null, width: 1440, only: null, skip: false, recaptureEds: false, recaptureOrigin: false, edsHost: null, consent: null, dismiss: [], blocked: null, tryBlocked: false, crawlShots: 'stardust/current/assets/screenshots', concurrency: 3, sample: 2, seed: null, importCheck: null, variance: null, retries: 4, threshold: 10, heightTol: 0.05, clipMax: 0, unitTol: 4, clip: true, content: true, units: null, compareOnly: false, warmup: null, vh: null };
  const fail = (m) => { console.error(`${m}\n\n${HELP}`); process.exit(1); };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]; const v = () => rest[++i];
    if (a === '--stage') { o.stage = v(); if (!['published', 'prototype'].includes(o.stage)) fail('--stage must be published or prototype'); }
    else if (a === '--proto-base') o.protoBase = v().replace(/\/$/, '');
    else if (a === '--state') o.state = v(); else if (a === '--coverage') o.coverage = v(); else if (a === '--out') o.out = v(); else if (a === '--width') o.width = Number(v());
    else if (a === '--only') o.only = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--skip-existing') o.skip = true; else if (a === '--recapture-eds') o.recaptureEds = true; else if (a === '--recapture-origin') o.recaptureOrigin = true;
    else if (a === '--eds-host') o.edsHost = v().replace(/\/$/, ''); else if (a === '--blocked') o.blocked = new RegExp(v()); else if (a === '--try-blocked') o.tryBlocked = true; else if (a === '--crawl-shots') o.crawlShots = v();
    else if (a === '--consent') o.consent = v(); else if (a === '--dismiss') o.dismiss = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (['--concurrency', '--origin-concurrency', '--eds-concurrency', '--probe-concurrency'].includes(a)) o.concurrency = Math.max(1, Number(v()) || 1);
    else if (a === '--sample') { const s = v(); o.sample = s === 'all' ? 'all' : Number(s); if (o.sample !== 'all' && !(o.sample >= 0)) fail('--sample takes a count or all'); }
    else if (a === '--seed') o.seed = v(); else if (a === '--import-check') o.importCheck = v(); else if (a === '--variance') o.variance = v(); else if (a === '--retries') o.retries = Number(v());
    else if (a === '--threshold') o.threshold = Number(v()); else if (a === '--height-tol') o.heightTol = Number(v()); else if (a === '--clip-max') o.clipMax = Number(v()); else if (a === '--unit-tol') o.unitTol = Number(v());
    else if (a === '--no-clip') o.clip = false; else if (a === '--no-content') o.content = false; else if (a === '--no-probes') { o.clip = false; o.content = false; }
    else if (a === '--units') o.units = v(); else if (a === '--compare-only') o.compareOnly = true; else if (a === '--warmup') o.warmup = v(); else if (a === '--vh') o.vh = Number(v());
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
  }
  if (o.stage === 'prototype' && o.content) o.content = false; // content-diff already reconciles the prototype's text
  if (!o.out) o.out = `stardust/replica/gates/${o.stage === 'prototype' ? 'prototypes' : 'all'}-${o.width}`;
  if (o.seed == null) o.seed = String(o.width);
  // the structural row is made of the probes: without them, or for prototypes and recomputes, every page is full
  o.tiered = o.stage === 'published' && o.sample !== 'all' && o.clip && o.content && !o.compareOnly;
  return o;
}

// ---- pure: the verdict --------------------------------------------------------------------------------
/**
 * verdict({ pixel, clip, content, units, override, allowance, structural }, opts) → row fields. `pixel` = pixel.json,
 * `clip` = { counts } (served side) or null, `content` = { totals } | { error } | null, `units` = { verdict } | null.
 * `structural` = { originH, edsH, skeleton } — the structural row (#141): no pixel criterion, the height from the
 * probes' settled document heights, the skeleton fit (`ok` false fails; null = not read).
 */
export function verdict({ pixel = {}, clip = null, content = null, units = null, override = null, allowance = 0, structural = null }, { threshold = 10, heightTol = 0.05, clipMax = 0, clipOn = true, contentOn = true } = {}) {
  const st = structural;
  const compared = st ? Number.isFinite(st.originH) && Number.isFinite(st.edsH) && st.originH > 0 : pixel.compared && Number.isFinite(pixel.heightDelta);
  const heightDelta = st ? (compared ? st.originH - st.edsH : null) : pixel.heightDelta;
  const originH = st ? (compared ? st.originH : null) : compared ? pixel.compared.height + Math.max(0, pixel.heightDelta) : null;
  const edsH = st ? (compared ? st.edsH : null) : compared ? pixel.compared.height + Math.max(0, -pixel.heightDelta) : null;
  const pixelPass = st ? null : compared && pixel.pct <= threshold;
  const heightPass = compared && Math.abs(heightDelta) <= heightTol * originH;
  const clipped = clip && clip.counts ? clip.counts.total : null;
  const clipPass = !clipOn ? null : clipped == null ? null : clipped <= clipMax + allowance;
  const cTot = content && content.totals ? content.totals : null;
  const contentPass = !contentOn ? null : cTot ? (cTot.missing + cTot.hidden) === 0 : null;
  // only the required families decide (`requiredOff`, unit-geometry verdictOf); advisory deltas on the same page — a runtime
  // list's cards (#144) — are reported, never failed. A verdict without the split counts every delta.
  // (an advisory family that finds nothing — a runtime list that rendered empty — is an advisory error)
  const unitMiss = (v) => (Number.isFinite(v.requiredOff) ? v.requiredOff : v.off + v.hidden + v.missing) + (Number.isFinite(v.requiredErrors) ? v.requiredErrors : v.errors);
  const unitPass = units && units.verdict && units.required ? unitMiss(units.verdict) === 0 : null;
  const skeletonPass = st && st.skeleton ? (st.skeleton.ok === false ? false : st.skeleton.ok === true ? true : null) : null;
  const reasons = [];
  if (!compared) reasons.push(st ? 'height not measured (probe error)' : pixel.error ? `pixel error: ${pixel.error}` : 'missing capture');
  if (compared && pixelPass === false) reasons.push(`pixel ${pixel.pct}% > ${threshold}%`);
  if (compared && !heightPass) reasons.push(`Δh ${heightDelta}px > ${Math.round(heightTol * 100)}% of ${originH}${st ? ' (docH)' : ''}`);
  if (clipPass === false) reasons.push(`clipped ${clipped}${allowance ? ` > allowance ${allowance}` : ''}${clip.counts ? ` (text ${clip.counts.textClipped + clip.counts.textHidden}, controls ${clip.counts.controlHidden + clip.counts.controlClipped})` : ''}`);
  if (contentPass === false) reasons.push(`content MISSING ${cTot.missing} / HIDDEN ${cTot.hidden}${cTot.controlState ? ` (+${cTot.controlState} control state)` : ''}`);
  if (unitPass === false) reasons.push(`units off ${units.verdict.off} hidden ${units.verdict.hidden} missing ${units.verdict.missing}${units.verdict.errors ? ` errors ${units.verdict.errors}` : ''}`);
  if (skeletonPass === false) reasons.push(`skeleton: ${st.skeleton.reason}`);
  const pixelOnlyPass = st ? null : !!(pixelPass && heightPass);
  const pass = !!compared && !!heightPass && (st || pixelPass) && clipPass !== false && contentPass !== false && unitPass !== false && skeletonPass !== false;
  return { originH, edsH, ...(st ? { heightDelta, heightSource: 'docH', skeletonPass } : {}), pixelPass: st ? null : !!pixelPass, heightPass: !!heightPass, clipped, clipPass, clipAllowance: allowance, contentPass, contentNA: contentOn && !cTot ? (content && content.error) || 'not probed' : null, unitPass, pixelOnlyPass, pass: !!pass, passWithOverride: !!pass || !!override, reasons };
}

const cell = (v, suffix = '') => (v == null ? 'n/a' : `${v}${suffix}`);
const gateCell = (r) => (!r.gateTier ? '-' : r.gateTier === 'structural' ? 'structural' : r.tierReason && /^(sample|escalated)/.test(r.tierReason) ? `full (${r.tierReason.split(':')[0]})` : 'full');
export function formatSummary(summary) {
  const t = summary.totals; const p = summary._provenance;
  const tiers = t.structural != null ? ` Tiers: **${t.full} full** (${t.sampled} sampled, ${t.escalated} escalated) / **${t.structural} structural** (${t.structuralPass} PASS) — siblings gated structurally carry \`gate: structural\`.` : '';
  const head = [`# ${p.stage === 'prototype' ? 'Prototype gate — every crafted prototype' : 'Published-origin gate — all deployed pages'}, ${p.breakpoint}px`, '', `${p.writtenAt} · **${t.pass} PASS / ${t.fail} FAIL / ${t.error} error of ${t.pages}**${t.overridePass ? ` (+${t.overridePass} documented override${t.overridePass > 1 ? 's' : ''} → ${t.passWithOverrides} delivered)` : ''}`, '', `Verdict: ${p.verdict}`, '', `Calibration — pixel-only verdict (criteria 1+2): **${t.pixelOnlyPass} PASS**; full verdict (1–4): **${t.pass} PASS**. Failing by criterion: pixel ${t.failPixel}, height ${t.failHeight}, clip ${t.failClip}, content ${t.failContent}${t.failUnits ? `, units ${t.failUnits}` : ''}; content n/a (origin not probed) ${t.contentNA}${t.degradedTier ? `; **${t.degradedTier} page(s) probed on a degraded browser tier** (Chrome elected, Chromium used — install Chrome for bot-managed origins)` : ''}${t.asymmetricOrigins ? `; ${t.asymmetricOrigins} asymmetric origin(s)` : ''}.${tiers}`, ''];
  const rows = ['| page | template | tier | gate | origin | browser | pixel % (text %) | Δh px | clipped | content | units | verdict | reasons |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of [...summary.rows].sort((a, b) => Number(b.pass) - Number(a.pass) || (a.pct ?? 999) - (b.pct ?? 999))) {
    const content = r.contentNA ? `n/a (${r.contentNA})` : r.content ? `MISSING ${r.content.missing} / HIDDEN ${r.content.hidden}${r.content.controlState ? ` / state ${r.content.controlState}` : ''}` : 'n/a';
    const units = r.units ? `off ${r.units.off} hidden ${r.units.hidden} missing ${r.units.missing}${r.unitsRequired ? '' : ' (advisory)'}` : '-';
    const verdictCell = r.error && r.pct == null && r.gateTier !== 'structural' ? `ERROR ${r.error}` : r.pass ? (r.gateTier === 'structural' ? 'PASS (structural)' : 'PASS') : r.pixelOnlyPass ? 'FAIL (elements)' : 'FAIL';
    const pctCell = r.gateTier === 'structural' ? 'structural' : `${cell(r.pct)}${r.textPct != null ? ` (${r.textPct})` : ''}`;
    rows.push(`| \`${r.path}\` | ${r.template ?? '-'} | ${r.tier ?? '-'} | ${gateCell(r)} | ${r.origin || '-'}${r.origin === 'crawl-fullpage' ? ' ⚠asym' : ''} | ${r.browser || '-'} | ${pctCell} | ${cell(r.heightDelta)}${r.heightSource === 'docH' ? ' (docH)' : ''} | ${cell(r.clipped)}${r.clipAllowance ? ` (allow ${r.clipAllowance})` : ''} | ${content} | ${units} | ${verdictCell}${r.masked ? ` (masked ${r.maskedRows} rows: ${r.maskReason})` : ''}${r.override && !r.pass ? ` → ${r.override.verdict}: ${r.override.reason}` : ''} | ${r.reasons.join('; ') || '-'} |`);
  }
  return `${head.join('\n')}${rows.join('\n')}\n`;
}

/** Totals over the rows. A structural row is gated (never an error) unless its probes failed. */
export function totalsOf(rows) {
  const n = (f) => rows.filter(f).length;
  const measured = (r) => (r.gateTier === 'structural' ? r.originH != null : r.pct != null);
  const t = { pages: rows.length, pass: n((r) => r.pass), pixelOnlyPass: n((r) => r.pixelOnlyPass), overridePass: n((r) => !r.pass && r.override), fail: n((r) => !r.pass && measured(r)), error: n((r) => !measured(r)),
    failPixel: n((r) => r.pct != null && !r.pixelPass), failHeight: n((r) => measured(r) && !r.heightPass), failClip: n((r) => r.clipPass === false), failContent: n((r) => r.contentPass === false), failUnits: n((r) => r.unitPass === false), contentNA: n((r) => r.contentNA), asymmetricOrigins: n((r) => r.originAsymmetric), degradedTier: n((r) => r.browser && r.browser !== 'chrome') };
  if (rows.some((r) => r.gateTier)) Object.assign(t, { full: n((r) => r.gateTier !== 'structural'), structural: n((r) => r.gateTier === 'structural'), structuralPass: n((r) => r.gateTier === 'structural' && r.pass), sampled: n((r) => /^sample/.test(r.tierReason || '')), escalated: n((r) => /^escalated/.test(r.tierReason || '')) });
  t.passWithOverrides = t.pass + t.overridePass;
  return t;
}

/**
 * The published selection (#141): state pages at `deployed`, or at `migrated` with a delivered URL — state
 * `liveUrl`, else the coverage row's `delivery.deployedUrl` while it is deployed / verified. → pages with
 * liveUrl, deployedPath, templates (coverage templateId + state template, for unit families).
 */
export function selectPages(statePages, coveragePages = []) {
  const cov = new Map((coveragePages || []).map((c) => [c.slug, c]));
  const out = [];
  for (const p of statePages || []) {
    if (!p.url) continue;
    const c = cov.get(p.slug); const d = c && c.delivery;
    const covUrl = d && ['deployed', 'verified'].includes(d.status) ? d.deployedUrl || null : null;
    const liveUrl = p.liveUrl || covUrl;
    if (!liveUrl || !['deployed', 'migrated'].includes(p.status)) continue; // a page state never migrated (a redirect source) is no row
    out.push({ ...p, liveUrl, deployedPath: p.deployedPath || (c && c.path) || null, templates: [...new Set([c && c.templateId, p.template].filter(Boolean))] });
  }
  return out;
}

/** The delivered document of a served page: `/x` → `/x.plain.html`, `/` and `/x/` → `…/index.plain.html`. */
export function plainUrl(url) { const u = new URL(url); u.pathname = `${u.pathname.endsWith('/') ? `${u.pathname}index` : u.pathname}.plain.html`; u.search = ''; u.hash = ''; return u.href; }

// ---- runner ---------------------------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const firstExisting = (cands) => cands.map((p) => resolve(HERE, p)).find((p) => existsSync(p));
const PIXEL = join(HERE, 'pixel-compare.mjs');
const DIFF_DIR = firstExisting(['../../diff/scripts', '../diff']);
const readJson = (p, d = null) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d; } catch { return d; } };
const lastLine = (s) => (s || '').trim().split('\n').filter(Boolean).pop() || '';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const errLine = (e) => String((e && e.message) || e).split('\n')[0];

function run(cmd, args, { timeoutMs = 480000 } = {}) {
  return new Promise((res) => {
    const ch = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { ch.kill('SIGKILL'); err += '\n[gate-all] TIMEOUT'; }, timeoutMs);
    ch.on('close', (code) => { clearTimeout(t); res({ code, out, err }); });
  });
}
/** A counting limiter: limit(fn) runs fn when fewer than n are running. */
function limiter(n) { let active = 0; const q = []; const next = () => { if (active >= n || !q.length) return; active += 1; const [fn, res, rej] = q.shift(); fn().then(res, rej).finally(() => { active -= 1; next(); }); }; return (fn) => new Promise((res, rej) => { q.push([fn, res, rej]); next(); }); }
/** Seconds per stage (summary _provenance.timing). */
function timer() { const kinds = {}; return { kinds, async time(kind, fn) { const t = Date.now(); try { return await fn(); } finally { const k = kinds[kind] || (kinds[kind] = { n: 0, s: 0 }); k.n += 1; k.s = Math.round((k.s + (Date.now() - t) / 1000) * 10) / 10; } } }; }

/** The page's _meta.json sidecars under the migrated tree → slug → meta. */
function loadMetas(dir) {
  const out = {};
  const walk = (d, depth) => { let ents = []; try { ents = readdirSync(d); } catch { return; } for (const e of ents) { const f = join(d, e); if (e === '_meta.json') { const m = readJson(f); if (m && m.slug) out[m.slug] = m; } else if (depth < 6 && !e.startsWith('.') && e !== 'assets') { try { if (statSync(f).isDirectory()) walk(f, depth + 1); } catch { /* gone */ } } } };
  walk(dir, 0);
  return out;
}
const jsonFiles = (p) => { if (!p || !existsSync(p)) return []; if (statSync(p).isDirectory()) return readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f)); return [p]; };

/** The latest row per slug across <out>/summary.json and <out>/runs/*.json — an archetype gated in another run. */
function priorRows(out) {
  const best = {};
  for (const f of [join(out, 'summary.json'), ...jsonFiles(join(out, 'runs'))]) {
    const s = readJson(f); if (!s || !Array.isArray(s.rows)) continue;
    const at = (s._provenance && s._provenance.writtenAt) || '';
    for (const r of s.rows) if (!best[r.slug] || best[r.slug].at < at) best[r.slug] = { at, row: r };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.row]));
}

/** GET a delivered document with the served-side back-off (429 / 5xx retried). */
async function fetchPlain(url, { retries = 3, backoffMs }) {
  for (let i = 0; ; i += 1) {
    let r = null; try { r = await fetch(plainUrl(url), { redirect: 'follow' }); } catch { r = null; }
    if (r && r.ok) return r.text();
    if (i >= retries || (r && r.status < 500 && r.status !== 429)) return null;
    await sleep(backoffMs(i));
  }
}

/**
 * A worker's browsers and contexts, kept across pages (#141): `stealth` (the probes' and the origin stitch's
 * real-Chrome tier) and `plain` (bundled Chromium — the served stitch, as the CLI ran it). Recycled after
 * `recycleAfter` pages and relaunched when a browser dies.
 */
function makeWorker({ chromium, ls, width, tm, recycleAfter = 25 }) {
  const browsers = {}; const contexts = {}; let pages = 0;
  const browser = async (kind) => {
    if (!browsers[kind] || !browsers[kind].isConnected()) { for (const k of Object.keys(contexts)) if (k.startsWith(`${kind}:`)) delete contexts[k]; browsers[kind] = await tm.time('browser launch', () => (kind === 'plain' ? chromium.launch() : ls.launchStealthHeaded(chromium))); }
    return browsers[kind];
  };
  const close = async () => { for (const b of Object.values(browsers)) await b.close().catch(() => {}); for (const k of Object.keys(browsers)) delete browsers[k]; for (const k of Object.keys(contexts)) delete contexts[k]; };
  return {
    browser,
    tier: (kind) => (browsers[kind] ? ls.browserTier(browsers[kind]) : null),
    async context(kind, side, height = 900) {
      const key = `${kind}:${side}:${height}`; const b = await browser(kind);
      if (!contexts[key]) contexts[key] = await ls.newLiveContext(b, { ua: ls.REAL_CHROME_UA, locale: 'en-US', viewport: { width, height } });
      return contexts[key];
    },
    async pageDone() { pages += 1; if (pages >= recycleAfter) { pages = 0; await close(); } },
    close,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!existsSync(opts.state)) { console.error(`gate-all: ${opts.state} not found — run from the project root or pass --state`); process.exit(1); }
  if (!DIFF_DIR) { console.error('gate-all: the diff skill\'s scripts dir was not found next to this one (../../diff/scripts or ../diff) — copy it (replica SKILL.md § Setup)'); process.exit(1); }
  const T0 = Date.now(); const tm = timer();
  const state = readJson(opts.state);
  const all = opts.stage === 'prototype'
    ? (state.pages || []).filter((p) => p.prototypePath && p.url).map((p) => ({ ...p, liveUrl: `${opts.protoBase || 'http://localhost:8791'}/${basename(p.prototypePath)}`, templates: [p.template].filter(Boolean) }))
    : selectPages(state.pages, (readJson(opts.coverage, {}) || {}).pages || []);
  if (opts.stage === 'prototype' && !opts.protoBase) console.error('gate-all: --stage prototype without --proto-base — assuming http://localhost:8791 (serve the prototypes dir there, replica SKILL.md § Phase 4)');
  const pages = opts.only ? all.filter((p) => opts.only.includes(p.slug)) : all;
  if (!pages.length) { console.error('gate-all: no deployed pages selected (state status deployed, or migrated with a delivered URL: state liveUrl or the coverage row)'); process.exit(1); }
  mkdirSync(opts.out, { recursive: true });
  const MASKS = readJson(join(opts.out, 'masks.json'), {}); const OVERRIDES = readJson(join(opts.out, 'overrides.json'), {});
  const CLIP_ALLOW = readJson(join(opts.out, 'clip-allow.json'), {}); const PRESENCE = readJson(join(opts.out, 'presence.json'), {});
  const FAMILIES = readJson('stardust/replica/units.json', null);
  const UNITS = readJson(opts.units || join(opts.out, 'units.json'), {});
  const ls = await import(pathToFileURL(join(DIFF_DIR, 'live-session.mjs')).href);
  const cp = await import(pathToFileURL(join(DIFF_DIR, 'content-presence.mjs')).href);
  const ug = await import(pathToFileURL(join(DIFF_DIR, 'unit-geometry.mjs')).href);
  const ml = await import(pathToFileURL(join(DIFF_DIR, 'measure-live.mjs')).href);
  const ss = await import(pathToFileURL(join(HERE, 'stitch-shot.mjs')).href);
  let chromium; let PNG;
  try { ({ chromium } = await import('playwright')); ({ PNG } = await import('pngjs')); } catch (e) { console.error(`gate-all: playwright / pngjs not importable from ${HERE} (${e.code || e.message}) — run the project copy (replica SKILL.md § Setup)`); process.exit(1); }
  const unitsOf = (p) => {
    if (!FAMILIES) return ((UNITS[p.slug] || {}).units || []).map((x) => ({ origin: x.origin, eds: x.eds || x.origin, n: x.n || 1, required: x.required !== false }));
    const seen = new Map(); for (const t of (p.templates.length ? p.templates : [null])) for (const u of ug.unitsFor(FAMILIES, p.slug, t)) seen.set(u.family, u);
    return [...seen.values()];
  };
  const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); writeFileSync(join(opts.out, '_run.log'), `${line}\n`, { flag: 'a' }); };
  const dir = (p) => join(opts.out, p.slug);
  const edsUrl = (p) => (opts.edsHost ? p.liveUrl.replace(/^https?:\/\/[^/]+/, opts.edsHost) : p.liveUrl);
  const served = opts.stage === 'published';
  const extra = [opts.consent, ...opts.dismiss].filter(Boolean);
  const results = {};
  const rec = (p, k, v) => { results[p.slug] = { ...(results[p.slug] || {}), [k]: v }; };
  const sopts = (side) => ({ width: opts.width, vh: opts.vh || 900, settle: true, consent: opts.consent, dismiss: opts.dismiss, noDismiss: false, headed: side === 'origin', locale: 'en-US', ua: ls.REAL_CHROME_UA, wait: 3000, timeout: 60000, eds: side === 'eds' && served, retries: opts.retries });
  // a 429 seen by one worker pauses every worker's served-side loads (the edge rate-limits the host, not the page)
  let servedPause = 0;
  const served429 = async () => { const wait = servedPause - Date.now(); if (wait > 0) await sleep(wait); };
  const retry = (what) => ({ retries: opts.retries, onRetry: (e, i, ms) => { servedPause = Math.max(servedPause, Date.now() + ms); log(`${what} not measurable (${errLine(e)}) — retry ${i + 1}/${opts.retries} in ${ms} ms (all workers)`); } });

  async function stitchTo(w, kind, side, url, so, out) {
    const once = async () => { if (so.eds) await served429(); const ctx = await w.context(kind, side, so.vh); const page = await ctx.newPage(); try { return await ss.captureStitched(page, url, so, { PNG, log: () => {}, warn: (m) => log(`${side} ${basename(dirname(out))} ${m.slice(0, 160)}`) }); } finally { await page.close().catch(() => {}); } };
    const cap = so.eds ? await ls.withServedRetry(once, retry(`stitch ${url}`)) : await once();
    writeFileSync(out, cap.pngBuf); writeFileSync(ss.sidecarOf(out), `${JSON.stringify(ss.captureRecord(url, so, cap), null, 2)}\n`);
    return cap;
  }
  async function captureOrigin(w, p) {
    const d = dir(p); mkdirSync(d, { recursive: true });
    const out = join(d, 'origin.png'); const meta = join(d, 'origin.json'); const prev = readJson(meta);
    if (opts.skip && !opts.recaptureOrigin && existsSync(out) && prev && !prev.error) { rec(p, 'origin', prev); return; }
    const crawlShot = join(opts.crawlShots, `${p.slug}.png`);
    const gateDir = join('stardust/replica/gates', `${p.slug}-${opts.width}`);
    const cachedLive = join(gateDir, 'live.png');
    const base = served && !opts.recaptureOrigin ? ss.baselineStatus(gateDir, { url: p.url, width: opts.width }) : { ok: false };
    let r;
    if (opts.stage === 'prototype' && existsSync(cachedLive)) { copyFileSync(cachedLive, out); r = { instrument: 'stitch-live', note: `reused ${cachedLive} (the archetype round's capture — hit minimisation)` }; }
    else if (base.ok) { copyFileSync(join(gateDir, ss.BASELINE_PNG), out); r = { instrument: 'baseline', url: p.url, note: `frozen origin baseline ${gateDir} (captured ${base.provenance.capturedAt})` }; }
    else if (opts.blocked && opts.blocked.test(p.url) && !opts.tryBlocked) {
      if (existsSync(crawlShot)) { copyFileSync(crawlShot, out); r = { instrument: 'crawl-fullpage', asymmetric: true, note: `origin matches --blocked ${opts.blocked}; crawl screenshot used (lazy rails may be placeholders)` }; }
      else r = { instrument: 'none', error: `origin blocked and no crawl shot at ${crawlShot}` };
    } else {
      try { const cap = await tm.time('origin stitch', () => stitchTo(w, 'stealth', 'origin', p.url, sopts('origin'), out)); r = { instrument: 'stitch-live', url: p.url, log: [`stitched ${out}: ${opts.width}x${cap.height} from ${cap.chunks} chunks`] }; }
      catch (e) {
        const why = `${e.name === 'BotChallengeError' ? 'bot challenge' : 'stitch'}: ${errLine(e)}`;
        if (existsSync(out) && prev && !prev.error && opts.recaptureOrigin) r = { ...prev, note: `re-shoot failed (${why}) — previous origin kept` };
        else if (existsSync(crawlShot)) { copyFileSync(crawlShot, out); r = { instrument: 'crawl-fullpage', asymmetric: true, note: `${why} — crawl screenshot used` }; }
        else r = { instrument: 'none', error: why };
      }
    }
    r.at = new Date().toISOString(); writeFileSync(meta, JSON.stringify(r, null, 2)); rec(p, 'origin', r);
    log(`origin ${p.slug} → ${r.instrument}${r.error ? ` ERROR ${r.error}` : ''}`);
  }
  async function captureEds(w, p) {
    const d = dir(p); mkdirSync(d, { recursive: true });
    const out = join(d, 'eds.png'); const meta = join(d, 'eds.json'); const prev = readJson(meta);
    if (opts.skip && !opts.recaptureEds && existsSync(out) && prev && !prev.error) { rec(p, 'eds', prev); return; }
    const url = edsUrl(p); let r;
    try { await tm.time('served stitch', () => stitchTo(w, 'plain', 'eds', url, sopts('eds'), out)); r = { instrument: 'stitch-live', url }; }
    catch (e) { r = { instrument: 'none', url, error: `${e.name === 'EdsNotReadyError' ? 'served page not measurable' : 'stitch'}: ${errLine(e)}` }; }
    r.at = new Date().toISOString(); writeFileSync(meta, JSON.stringify(r, null, 2)); rec(p, 'eds', r);
    log(`eds ${p.slug} → ${r.instrument}${r.error ? ` ERROR ${r.error}` : ''}`);
  }
  // The DOM probes on ONE load per side (#141): presence + clip inventories (content-presence) and the unit
  // inventories (unit-geometry) on the same settled page; the outputs keep the CLIs' JSON shapes.
  async function probe(w, p) {
    const d = dir(p); mkdirSync(d, { recursive: true });
    const pr = PRESENCE[p.slug] || {};
    const [mainO, mainE] = pr.main ? [pr.main.split('=')[0], pr.main.split('=')[1] || pr.main.split('=')[0]] : [null, null];
    const pairs = (pr.variable || []).map((s) => s.split('=')); const varO = pairs.map((x) => x[0]); const varE = pairs.map((x) => x[1] || x[0]);
    const units = unitsOf(p); const n = units.length ? Math.max(...units.map((x) => x.n)) : 1;
    const also = (sels) => (units.length ? async (page, v) => ({ docH: v.docH, bySel: await ug.unitsOnPage(page, sels, n) }) : null);
    const side = { width: opts.width, locale: 'en-US', minCut: 2, settlePasses: 4, extra };
    let o = null; let oErr = null;
    if (opts.content || units.length || opts.tiered) {
      const cacheF = join(d, 'origin-probe.json');
      const key = JSON.stringify({ w: opts.width, mainO, varO, units: units.map((u) => u.origin), n, extra, warmup: opts.warmup });
      const cached = opts.skip && !opts.recaptureOrigin ? readJson(cacheF) : null;
      if (cached && cached.key === key) o = cached.inv;
      else {
        try {
          o = await tm.time('probe origin', async () => cp.inventorySide(null, p.url, { ...side, context: await w.context('stealth', 'origin-probe'), warmup: opts.warmup, rootSel: mainO, variableSels: varO, httpError: 'throw', also: also(units.map((u) => u.origin)) }));
          writeFileSync(cacheF, JSON.stringify({ key, at: o.at, inv: o }));
          if (units.length && o.also) ml.writeCache(ug.unitCacheKey(p.slug, opts.width), { url: p.url, at: o.at, status: o.status, docH: o.also.docH, bySel: o.also.bySel, width: opts.width });
        } catch (e) { oErr = e.name === 'BotChallengeError' ? 'origin bot challenge' : e.name === 'LiveHTTPError' ? `origin ${errLine(e)}` : `origin probe: ${errLine(e)}`; }
      }
    }
    let e = null; let eErr = null;
    try {
      e = await tm.time('probe served', () => ls.withServedRetry(async () => { if (served) await served429(); return cp.inventorySide(null, edsUrl(p), { ...side, context: await w.context('stealth', 'eds-probe'), warmup: null, rootSel: mainE, variableSels: varE, eds: served, also: also(units.map((u) => u.eds)) }); }, retry(`probe ${p.slug}`)));
    } catch (err) { eErr = `served ${err.name === 'EdsNotReadyError' ? 'page not measurable' : 'probe'}: ${errLine(err)}`; }
    const tier = w.tier('stealth');
    rec(p, 'heights', { origin: o ? o.docH : null, eds: e ? e.docH : null });
    if (opts.content) {
      if (o && e) {
        const { out: content } = cp.presenceReport(o, e, { width: opts.width, variable: varO, chrome: false, tier });
        writeFileSync(join(d, 'content.json'), JSON.stringify(content, null, 1));
        rec(p, 'content', { totals: content.totals, scope: content.scope, variable: pr.variable || [], reason: pr.reason || null, tier });
        rec(p, 'clip', { counts: content.eds.clip.counts, groups: content.eds.clip.groups, origin: content.origin.clip.counts, source: 'content-presence' });
        writeFileSync(join(d, 'clip.json'), JSON.stringify({ url: edsUrl(p), at: content._provenance.at, source: 'content-presence', counts: content.eds.clip.counts, groups: content.eds.clip.groups, origin: { counts: content.origin.clip.counts } }, null, 1));
        if (content.textBoxes && content.textBoxes.origin) writeFileSync(join(d, 'text-boxes.json'), JSON.stringify({ side: 'origin', boxes: content.textBoxes.origin }));
        log(`content ${p.slug} → MISSING ${content.totals.missing} HIDDEN ${content.totals.hidden} state ${content.totals.controlState}; clipped ${content.eds.clip.counts.total}`);
      } else { rec(p, 'content', { error: oErr || eErr }); log(`content ${p.slug} → n/a (${oErr || eErr})`); }
    }
    if (opts.clip && !(results[p.slug] && results[p.slug].clip)) {
      if (e) { rec(p, 'clip', { counts: e.clip.counts, groups: e.clip.groups, source: 'clip-probe', tier }); writeFileSync(join(d, 'clip.json'), JSON.stringify({ url: edsUrl(p), at: e.at, source: 'clip-probe', counts: e.clip.counts, groups: e.clip.groups }, null, 1)); log(`clip ${p.slug} → ${e.clip.counts.total}`); }
      else { rec(p, 'clip', { error: eErr }); log(`clip ${p.slug} → ERROR ${eErr}`); }
    }
    if (units.length) {
      const required = units.some((x) => x.required);
      if (o && e && o.also && e.also) {
        const res = ug.unitsReport({ url: p.url, at: o.at, docH: o.also.docH, bySel: o.also.bySel }, { url: edsUrl(p), at: e.at, docH: e.also.docH, bySel: e.also.bySel }, units, { tol: opts.unitTol, n, width: opts.width, tier });
        writeFileSync(join(d, 'units.json'), JSON.stringify(res, null, 1));
        rec(p, 'units', { verdict: res.verdict, required }); log(`units ${p.slug} → off ${res.verdict.off} hidden ${res.verdict.hidden} missing ${res.verdict.missing}`);
      } else { rec(p, 'units', { error: oErr || eErr || 'not measured', required }); log(`units ${p.slug} → ERROR ${oErr || eErr}`); }
    }
  }
  async function compare(p) {
    const d = dir(p); const r = results[p.slug] || {};
    if (!existsSync(join(d, 'origin.png')) || !existsSync(join(d, 'eds.png')) || (r.eds && r.eds.error) || (r.origin && r.origin.error)) { rec(p, 'pixel', { error: (r.eds && r.eds.error) || (r.origin && r.origin.error) || 'missing capture' }); return; }
    const mk = MASKS[p.slug];
    const args = [PIXEL, join(d, 'origin.png'), join(d, 'eds.png'), '--out', join(d, 'diff.png'), '--threshold', String(opts.threshold), '--json', '--timeout', '300'];
    if (mk && mk.masks && mk.masks.length) args.push('--mask', mk.masks.join(','));
    if (existsSync(join(d, 'text-boxes.json'))) args.push('--text-boxes', join(d, 'text-boxes.json'));
    const out = await tm.time('pixel compare', () => run('node', args));
    let px; try { px = JSON.parse(out.out); } catch { px = { error: lastLine(out.err) || `exit ${out.code}` }; }
    if (mk && mk.masks && mk.masks.length && !px.error) px.maskReason = mk.reason || null;
    writeFileSync(join(d, 'pixel.json'), JSON.stringify(px, null, 2)); rec(p, 'pixel', px);
    log(`pixel ${p.slug} → ${px.error ? `ERROR ${px.error}` : `${px.pct}% Δh ${px.heightDelta}${px.textPct != null ? ` text ${px.textPct}%` : ''} ${px.pass ? 'PASS' : 'FAIL'}${px.maskedRows ? ` [MASKED ${px.maskedRows} rows: ${px.maskReason}]` : ''}`}`);
  }

  // ---- tiers (#141) ----
  const metas = loadMetas('stardust/migrated');
  const roles = resolveRoles((state.pages || []).filter((p) => p.url), { metas, variance: jsonFiles(opts.variance).map((f) => readJson(f)).filter(Boolean) });
  const importCheck = indexImportCheck(jsonFiles(opts.importCheck || 'stardust/migrate/import-check').map((f) => readJson(f, [])));
  const prior = priorRows(opts.out);
  const bySlug = new Map(all.map((p) => [p.slug, p]));
  const inRun = new Set(pages.map((p) => p.slug));
  const plan = {}; const skeletons = {}; const finalRows = {}; const groups = new Map(); const structuralDone = new Set();
  const isSib = (p) => opts.tiered && roles[p.slug] && roles[p.slug].role === 'sibling';
  for (const p of pages) if (isSib(p)) groups.set(roles[p.slug].archetype, [...(groups.get(roles[p.slug].archetype) || []), p]);

  const rowOf = (p) => {
    const r = results[p.slug] || {}; const px = r.pixel || {}; const pl = plan[p.slug] || { gateTier: 'full', reason: null };
    const structural = pl.gateTier === 'structural' ? { originH: r.heights ? r.heights.origin : null, edsH: r.heights ? r.heights.eds : null, skeleton: pl.skeleton ? { ok: pl.skeleton.orderOk, reason: pl.skeleton.reason } : null } : null;
    const v = verdict({ pixel: px, clip: r.clip && r.clip.counts ? r.clip : null, content: r.content || null, units: r.units || null, override: OVERRIDES[p.slug] || null, allowance: (CLIP_ALLOW[p.slug] || {}).max || 0, structural }, { threshold: opts.threshold, heightTol: opts.heightTol, clipMax: opts.clipMax, clipOn: opts.clip, contentOn: opts.content });
    const role = roles[p.slug] || {};
    return { slug: p.slug, path: p.deployedPath || new URL(p.liveUrl).pathname, template: p.templates[0] || p.template, tier: p.fidelityTier || role.role || null, gateTier: pl.gateTier, tierReason: pl.reason, archetype: role.archetype || null,
      skeleton: pl.skeleton ? { orderOk: pl.skeleton.orderOk, newTokens: pl.skeleton.newTokens, missing: pl.skeleton.missing } : null, origin: r.origin && r.origin.instrument, originAsymmetric: !!(r.origin && r.origin.asymmetric), eds: r.eds && r.eds.instrument,
      pct: structural ? null : px.pct ?? null, textPct: structural ? null : px.textPct ?? null, heightDelta: structural ? v.heightDelta : px.heightDelta ?? null, ...v,
      clipGroups: r.clip && r.clip.groups ? r.clip.groups.filter((g) => !g.advisory).slice(0, 6) : [], clipAllowReason: (CLIP_ALLOW[p.slug] || {}).reason || null,
      content: r.content && r.content.totals ? { missing: r.content.totals.missing, hidden: r.content.totals.hidden, controlState: r.content.totals.controlState, missingButtons: r.content.totals.missingButtons, hiddenButtons: r.content.totals.hiddenButtons, findings: r.content.totals.findings, scope: r.content.scope, variable: r.content.variable } : null,
      units: r.units && r.units.verdict ? r.units.verdict : null, unitsRequired: !!(r.units && r.units.required), unitsError: (r.units && r.units.error) || null,
      browser: (r.content && r.content.tier) || (r.clip && r.clip.tier) || null,
      override: OVERRIDES[p.slug] || null, masked: !!px.maskedRows, maskedRows: px.maskedRows || 0, maskReason: px.maskReason || null,
      hotBands: (px.bands || []).filter((b) => b.pct > 15).map((b) => `${b.y0}-${b.y1}:${b.pct}%`), error: structural ? (v.originH == null ? (r.content && r.content.error) || 'probe error' : null) : px.error || (r.origin && r.origin.error) || (r.eds && r.eds.error) || null };
  };

  const queue = []; let active = 0; const pending = new Set();
  const enqueue = (p, mode) => queue.push({ p, mode });
  function planGroup(arch) {
    const list = groups.get(arch); if (!list) return; groups.delete(arch);
    const row = finalRows[arch] || prior[arch] || null;
    const gated = !!(row && (row.pass || row.override));
    const ccOk = Object.fromEntries(list.map((p) => [p.slug, contentCountOk(p.slug, { metas, importCheck })]));
    const pl = planTiers(list, { roles, skeletons, archetypeGated: { [arch]: gated }, ccOk, sample: opts.sample, seed: opts.seed });
    Object.assign(plan, pl);
    log(`tiers ${arch} (${row ? (gated ? 'gated' : 'NOT gated') : 'no row'}): ${list.filter((p) => pl[p.slug].gateTier === 'full').map((p) => `${p.slug} [${pl[p.slug].reason}]`).join(', ') || 'no full row'}; structural ${list.filter((p) => pl[p.slug].gateTier === 'structural').length}`);
    for (const p of list) if (pl[p.slug].gateTier === 'full') enqueue(p, 'full');
    for (const p of list) if (pl[p.slug].gateTier === 'structural') enqueue(p, 'structural');
  }
  // a sampled sibling's pixel FAIL: the template's rendering is not proven — every structural sibling of that archetype
  function escalateGroup(arch, why) {
    for (const [slug, pl] of Object.entries(plan)) {
      if (pl.archetype !== arch || pl.gateTier !== 'structural') continue;
      pl.gateTier = 'full'; pl.reason = `escalated: ${why}`;
      if (structuralDone.has(slug)) { structuralDone.delete(slug); delete finalRows[slug]; enqueue(bySlug.get(slug), 'capture'); }
    }
  }
  function finalize(p) {
    const row = rowOf(p); finalRows[p.slug] = row;
    const pl = plan[p.slug] || {};
    if (/^sample/.test(pl.reason || '') && row.pct != null && row.pixelPass === false) { log(`tiers ${p.slug}: sampled pixel FAIL ${row.pct}% → every structural sibling of ${pl.archetype} escalated`); escalateGroup(pl.archetype, `sampled ${p.slug} pixel ${row.pct}%`); }
    if (groups.has(p.slug)) planGroup(p.slug);
  }
  const compareLimit = limiter(4);
  const startCompare = (p) => { const job = compareLimit(() => compare(p)).catch((e) => rec(p, 'pixel', { error: errLine(e) })).then(() => finalize(p)).finally(() => pending.delete(job)); pending.add(job); };
  async function captures(p, w) {
    if (!opts.compareOnly) { await captureOrigin(w, p); await captureEds(w, p); return; }
    for (const side of ['origin', 'eds']) { const m = readJson(join(dir(p), `${side}.json`)); if (m) rec(p, side, m); }
  }
  // full: captures → probes → pixel (async, finalize after); structural: probes → row → PASS stands, else the full row
  async function handle(w, { p, mode }) {
    let comparing = false;
    try {
      if (mode === 'capture') { await captures(p, w); startCompare(p); comparing = true; return; }
      const full = mode === 'full' || plan[p.slug].gateTier === 'full';
      if (full) await captures(p, w);
      await probe(w, p);
      if (!full) {
        const row = rowOf(p);
        if (plan[p.slug].gateTier === 'structural' && row.pass) { finalRows[p.slug] = row; structuralDone.add(p.slug); log(`structural ${p.slug} → PASS (Δh ${row.heightDelta} docH, clipped ${row.clipped}, content ${row.content ? `MISSING ${row.content.missing} HIDDEN ${row.content.hidden}` : 'n/a'})`); return; }
        if (plan[p.slug].gateTier === 'structural') { plan[p.slug] = { ...plan[p.slug], gateTier: 'full', reason: `escalated: ${row.reasons.join('; ') || 'structural row flagged'}` }; log(`structural ${p.slug} → flagged (${plan[p.slug].reason}) → full row`); }
        await captures(p, w);
      }
      startCompare(p); comparing = true;
    } catch (e) { log(`${p.slug} ${mode} ERROR ${errLine(e)}`); }
    finally { if (!comparing && !finalRows[p.slug]) finalize(p); await w.pageDone(); }
  }

  // skeletons of the siblings and their archetypes (the delivered documents — no browser)
  const need = new Set(); for (const [arch, list] of groups) { need.add(arch); for (const p of list) need.add(p.slug); }
  const getLimit = limiter(4);
  await tm.time('skeleton fetch', () => Promise.all([...need].map((slug) => getLimit(async () => {
    const p = bySlug.get(slug); if (!p) { skeletons[slug] = null; return; }
    const html = await fetchPlain(edsUrl(p), { retries: opts.retries, backoffMs: ls.backoffMs });
    skeletons[slug] = html == null ? null : parseSkeleton(html);
  }))));
  for (const p of pages) if (!isSib(p)) { plan[p.slug] = { gateTier: 'full', reason: (roles[p.slug] && roles[p.slug].role) || 'unique' }; enqueue(p, 'full'); }
  for (const arch of [...groups.keys()]) if (!inRun.has(arch)) planGroup(arch); // gated (or not) in an earlier run
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, pages.length)) }, () => makeWorker({ chromium, ls, width: opts.width, tm }));
  await Promise.all(workers.map(async (w) => {
    for (;;) {
      const t = queue.shift();
      if (!t) { if (!active && !pending.size && !queue.length) break; await sleep(300); continue; }
      active += 1;
      try { await handle(w, t); } finally { active -= 1; }
    }
    await w.close();
  }));
  // an archetype outside the selection whose siblings never got planned (it has no row anywhere) — plan them now
  for (const arch of [...groups.keys()]) { planGroup(arch); }
  if (queue.length) {
    const w = makeWorker({ chromium, ls, width: opts.width, tm });
    while (queue.length || pending.size) { const t = queue.shift(); if (t) await handle(w, t); else await sleep(300); }
    await w.close();
  }

  const rows = pages.map((p) => finalRows[p.slug] || rowOf(p));
  const totals = totalsOf(rows);
  const originHost = (() => { try { return new URL(pages[0].url).origin; } catch { return null; } })();
  const timing = { wallS: Math.round((Date.now() - T0) / 1000), workers: workers.length, stages: tm.kinds };
  const summary = { _provenance: { writtenBy: 'gate-all.mjs', writtenAt: new Date().toISOString(), stage: opts.stage, breakpoint: opts.width, threshold: opts.threshold, heightTolerance: opts.heightTol, clipMax: opts.clipMax, unitTol: opts.unitTol, criteria: { pixel: true, height: true, clip: opts.clip, content: opts.content }, verdict: `overlap pixel % ≤ ${opts.threshold} AND |Δh| ≤ ${Math.round(opts.heightTol * 100)}% of origin height${opts.clip ? ` AND clipped ≤ ${opts.clipMax} (+ documented allowance)` : ''}${opts.content ? ' AND content MISSING + HIDDEN links/headings = 0' : ''}`, tiers: opts.tiered ? { sample: opts.sample, seed: opts.seed, rule: 'source-fidelity-gate.md § The all-pages published-origin gate (#141)' } : null, timing, origin: originHost, eds: opts.edsHost || (() => { try { return new URL(pages[0].liveUrl).origin; } catch { return null; } })(), edsHostOverride: opts.edsHost || null, only: opts.only }, totals, rows };
  const md = formatSummary(summary);
  if (opts.only) { mkdirSync(join(opts.out, 'runs'), { recursive: true }); const f = join(opts.out, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${opts.only[0]}.json`); writeFileSync(f, JSON.stringify(summary, null, 2)); console.log(md); console.log(`run → ${f}`); }
  else { writeFileSync(join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2)); writeFileSync(join(opts.out, 'summary.md'), md); console.log(md.split('\n').slice(0, 7).join('\n')); console.log(`summary → ${join(opts.out, 'summary.md')}`); }
  console.log(JSON.stringify(totals)); console.log(`timing ${JSON.stringify(timing)}`);
  process.exitCode = totals.pass + totals.overridePass === totals.pages ? 0 : 2;
}

function safeRealpath(p) { try { return realpathSync(p); } catch { return p; } }
if (process.argv[1] && fileURLToPath(import.meta.url) === safeRealpath(process.argv[1])) {
  main().catch((e) => { console.error(`gate-all error: ${e.message}`); process.exit(1); });
}
