#!/usr/bin/env node
/**
 * skills/replica/scripts/stitch-shot.mjs
 *
 * Scroll-and-stitch full-page screenshot for the stardust:replica
 * source-fidelity gate. Chromium's fullPage:true (captureBeyondViewport)
 * renders lazy-decoded images as gray placeholders on JS-heavy live sites —
 * a fullPage shot of a page whose DOM says "loaded" can still be visually
 * wrong. This tool scrolls viewport by viewport, waits for in-viewport image
 * completeness per chunk, screenshots each chunk, and stitches the PNG.
 *
 * Run it IDENTICALLY on the live page and on the served prototype so the
 * instrument is symmetric — an asymmetric capture (fullPage on one side,
 * stitch on the other) manufactures pixel diffs that aren't there.
 *
 * Hardening baked in (each one is a recorded false-measurement trap; the
 * live-navigation pieces live in the shared ../../diff/scripts/live-session.mjs):
 *   - real-Chrome UA + the STANDARD REQUEST HEADERS by default: the default
 *     HeadlessChrome UA gets a Cloudflare managed challenge on many live
 *     sites, and UA alone still 403s on Akamai (F-R1) — the standard headers
 *     (Accept / Accept-Language / sec-ch-ua*) are the other half of the fix.
 *   - a bot-management challenge/blocked interstitial FAILS LOUD (exit 3),
 *     never captured as if it were the source (the Access-Denied trap). So
 *     does a 2xx DENIAL PAGE (live-session's pageDenial owns the rule): gotoLive
 *     reads the entry, and the page is read once more after the dismissal
 *     sweep(s), before the capture (a denial page a script renders after
 *     domcontentloaded). The message names the signature and says "origin
 *     blocked"; a re-check that cannot read the page is one stderr line
 *     (`denial-page check skipped`), never a pass. Escalate with --headed
 *     (stealth real Chrome).
 *   - waitUntil 'domcontentloaded' (never 'networkidle'): live sites with
 *     analytics beacons never reach networkidle — hard timeout otherwise.
 *   - TWO overlay classes dismissed: cookie consent (CLICKED accept, not DOM
 *     removal, so consent-gated layout settles the way a real visit does)
 *     AND timed marketing/newsletter interstitials (CH-1: an undismissed
 *     "Sign up!" modal bakes a pixel-diff contributor into the live capture
 *     that no prototype fidelity can null out). The mouse is PARKED
 *     afterwards (bottom-left): a dismissal click leaves the cursor over the
 *     page, and any :hover-styled element under it would be silently
 *     captured in hover state. --consent / --dismiss add a site's own
 *     selectors; --no-dismiss turns both classes off (gate.sh passes all
 *     three through to BOTH captures, so the live side is dismissed exactly
 *     like the build side).
 *   - --locale pins Accept-Language + context locale: geo-redirecting sites
 *     (recorded: a car brand → /ch-de/, a fashion brand → /ww/) otherwise capture
 *     a different locale per run — nondeterministic live side.
 *   - animation/transition freeze is injected AFTER the lazyload settle
 *     pass: injecting it before breaks some lazy loaders' swap logic. The
 *     freeze also pauses every <video> at t=0 and clears all pending JS
 *     timeouts/intervals (CSS-only freezing stops neither <video> playback
 *     nor slick-style autoplay timers — the same page never pixel-matched
 *     itself), then clicks the first slick-convention carousel dot so both
 *     sides capture slide 1 deterministically. All symmetric — applied
 *     identically to live and prototype, so it cannot bias the diff.
 *   - FONT-LOAD assertion before capture (F-B2 companion): a webfont that
 *     failed to fetch renders the whole capture in fallback type — the same
 *     silent-false-measurement class as capturing a challenge page. After
 *     document.fonts.ready, any declared FontFace with status 'error' is
 *     reported LOUDLY with the family names; the operator must decide
 *     whether the failure is instrument-induced (a capture defect — fix the
 *     instrument) or real on the live site (capture-state — log it).
 *   - page height is measured AFTER the settle pass: entrance-animated
 *     sites inflate scrollHeight until elements go inview, so the
 *     pre-settle height is fake.
 *
 * Usage:
 *   node skills/replica/scripts/stitch-shot.mjs <url> <out.png> [options]
 *     --width <px>        viewport width                    (default 1440)
 *     --vh <px>           viewport height / chunk size      (default 900)
 *     --settle            slow-scroll lazyload settle pass before capture
 *                         (use on live JS-heavy pages; harmless elsewhere)
 *     --consent <sel>     extra consent-accept selector, tried before the
 *                         built-in candidates (OneTrust, "Accept all", …)
 *     --dismiss <sel,...> extra overlay-dismiss selectors (marketing modals
 *                         with non-standard close controls)
 *     --no-dismiss        dismiss no overlay at all (gate.sh --no-dismiss)
 *     --headed            escalation: headed stealth real Chrome
 *     --locale <tag>      pin Accept-Language + locale (e.g. en-GB)
 *     --ua <string>       user agent                        (default real-Chrome)
 *     --wait <ms>         initial post-load wait            (default 1200; 3000 with --settle)
 *     --timeout <ms>      goto timeout                      (default 60000)
 *     --freeze-baseline   origin baseline (opt-in, default OFF): the capture is
 *                         frozen as <dir>/baseline.png + baseline.json beside
 *                         <out.png>, for gate.sh --gate-against-baseline (below)
 *     --check-baseline    print a fresh shot's Δheight vs the frozen baseline
 *     --force             re-freeze over an existing baseline
 *     --eds [--retries 3] served side: decorated + no 429/5xx, else retry, exit 5
 *   node skills/replica/scripts/stitch-shot.mjs baseline <dir> [--url <u>] [--width <px>]
 *   node skills/replica/scripts/stitch-shot.mjs record <live.json> --origin live|baseline …
 *                         the gate's bookkeeping, no browser (HELP § Origin baseline)
 *
 * Example:
 *   node skills/replica/scripts/stitch-shot.mjs https://www.example.com \
 *     stardust/replica/gates/home-1440/live.png --width 1440 --settle
 *
 * Writes <out.png> and <stem>.capture.json beside it (live.png →
 * live.capture.json): { writtenBy, url, width, vh, height (the PNG's),
 * chunks, denialCheck ('ok' | 'skipped: <reason>' — the denial-page read
 * after the dismissal sweeps), at }. Removed when a capture starts, written
 * with the PNG — a failed or refused capture leaves none. A --freeze-baseline
 * capture writes baseline.json instead (HELP § Origin baseline).
 *
 * Requires: playwright, pngjs (project devDependencies; imported lazily, so
 * --help and the two subcommands need neither), and the diff skill's scripts
 * dir alongside (live-session.mjs — the replica Setup copies both).
 * Exit codes: 0 written, 1 error, 2 a baseline refusal (exists without --force,
 * fonts failed, a check aimed at baseline.png), 3 bot challenge (live side
 * blocked — an edge interstitial or a 2xx denial page; fail loud, never
 * captured, no PNG and no capture.json; escalate with --headed), 5 --eds page
 * not measurable (undecorated, 429 / 5xx through every retry). One capture on
 * an open page is exported as `captureStitched` (gate-all's in-process workers).
 */

/* eslint-disable import/no-extraneous-dependencies, import/extensions, no-await-in-loop, no-restricted-syntax, brace-style, object-curly-newline, max-len */
/* standalone dev tool: sequential page ops use awaited loops by design */
import { writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync, renameSync, rmSync } from 'fs';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// live-session.mjs lives in the diff skill's scripts dir. Two layouts exist:
// the plugin tree (skills/replica/scripts ↔ skills/diff/scripts) and the
// documented project copy (scripts/replica ↔ scripts/diff) — resolve either,
// so a project re-copy can't silently sever the shared hardening.
const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_SESSION = ['../../diff/scripts/live-session.mjs', '../diff/live-session.mjs']
  .map((p) => resolvePath(HERE, p)).find((p) => existsSync(p));
if (!LIVE_SESSION) {
  console.error('stitch-shot error: live-session.mjs not found (looked in ../../diff/scripts/ and ../diff/). Copy the diff skill\'s scripts dir alongside this one (replica SKILL.md § Setup).');
  process.exit(1);
}
const liveSession = await import(pathToFileURL(LIVE_SESSION).href);
const { REAL_CHROME_UA, isLiveHttpUrl, launchStealthHeaded, newLiveContext, gotoLive, dismissOverlays } = liveSession;

const HELP = `stitch-shot — scroll-and-stitch full-page screenshot (symmetric capture instrument)

Usage: node stitch-shot.mjs <url> <out.png> [options]
  --width <px>      viewport width (default 1440)
  --vh <px>         viewport height / chunk size (default 900)
  --settle          slow-scroll lazyload settle pass before capture
  --consent <sel>   extra consent-accept selector (clicked, not removed)
  --dismiss <sel,…> extra overlay-dismiss selectors (marketing modals etc.)
  --no-dismiss      dismiss no overlay at all (gate.sh --no-dismiss pass-through)
  --headed          headed stealth real Chrome (escalation for bot-managed sites)
  --locale <tag>    pin Accept-Language + locale (e.g. en-GB) for geo determinism
  --ua <string>     user agent (default: real-Chrome desktop UA + standard headers)
  --wait <ms>       initial post-load wait (default 1200; 3000 with --settle)
  --timeout <ms>    goto timeout (default 60000)
  --freeze-baseline freeze this capture as the origin baseline (opt-in; default OFF): it is ALWAYS written as
                    baseline.png in <out.png>'s dir (+ baseline.json: capturedAt, url, width, vh, height, settle,
                    chunks, fontsFailed), both atomic — <out.png> names the dir only; a freeze aimed at live.png
                    writes baseline.png beside it and never touches live.png (one stderr line). Refused (exit 2,
                    nothing written) when a baseline exists (pass --force) or the capture's fonts failed.
  --check-baseline  capture a fresh shot to <out.png> and print its Δheight vs the frozen baseline in <out.png>'s
                    dir — no verdict; never writes baseline.png: <out.png> named baseline.png is refused (exit 2)
  --force           re-freeze over an existing baseline (with --freeze-baseline)
  --eds             the URL is a served EDS page: shot only once every section and block reports loaded and no
                    document / style / script / font on its host answered 429 or 5xx; else retried with jittered
                    back-off (--retries, default 3), then exit 5 — no PNG (#141)
  --help            this text

Origin baseline (opt-in, default OFF — gate.sh --gate-against-baseline): one frozen origin per page and width,
so the live site changing between rounds cannot move the pixel gate's target. Two subcommands carry the gate's
bookkeeping — no browser, no network:
  node stitch-shot.mjs baseline <dir> [--url <u>] [--width <px>]
                    is a usable frozen baseline there? baseline.png AND baseline.json (a lone PNG is not one),
                    readable, frozen for this URL and width when given → its capturedAt on stdout, exit 0;
                    else the one-line reason (missing, lone file, unreadable, stale: another URL or width) on
                    stdout, exit 1 — a caller captures one line either way
  node stitch-shot.mjs record <live.json> --origin live|baseline --url <u> --width <px>
                    [--baseline <baseline.json>] [--at <iso>]
                    write the round's live.json beside live.png (atomic): writtenBy, origin, url, width, at —
                    "baseline" (the frozen origin copied over live.png: --baseline required, at = its capturedAt,
                    plus originBaseline { capturedAt, height }) or "live" (a fresh capture, at = --at).
                    A round without the flag retakes a live.png whose record says "baseline". Exit 0; 1 usage.

Writes <out.png> and <stem>.capture.json beside it (live.png → live.capture.json; removed when a capture starts, so a
failed or refused one leaves none): { writtenBy, url, width, vh, height, chunks, denialCheck, at } — denialCheck = 'ok' |
'skipped: <reason>' (the denial-page read after the dismissal sweeps). A --freeze-baseline capture writes baseline.json
instead.
Run the SAME command shape against the live page and the served prototype.
Exit codes: 0 written, 1 error, 2 baseline refusal, 3 bot challenge (live side blocked — an edge interstitial or a
2xx denial page, read by live-session's pageDenial at the entry and after the dismissal sweeps; fail loud, never
captured: no PNG, no capture.json; escalate --headed), 5 --eds page not measurable (undecorated / 429 / 5xx).`;
export { HELP };
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); process.exit(0); }
export class UsageError extends Error { constructor(msg) { super(msg); this.name = 'UsageError'; } }

export function parseArgs(argv) {
  const rest = argv.slice(2);
  const pos = [];
  const opts = { width: 1440, vh: 900, settle: false, consent: null, dismiss: [], noDismiss: false, headed: false, locale: null, ua: REAL_CHROME_UA, wait: null, timeout: 60000, freezeBaseline: false, checkBaseline: false, force: false, eds: false, retries: 3 };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--width') { opts.width = Number(rest[i += 1]); }
    else if (a === '--vh') { opts.vh = Number(rest[i += 1]); }
    else if (a === '--settle') { opts.settle = true; }
    else if (a === '--consent') { opts.consent = rest[i += 1]; }
    else if (a === '--dismiss') { opts.dismiss = (rest[i += 1] || '').split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--no-dismiss') { opts.noDismiss = true; }
    else if (a === '--headed') { opts.headed = true; }
    else if (a === '--locale') { opts.locale = rest[i += 1]; }
    else if (a === '--ua') { opts.ua = rest[i += 1]; }
    else if (a === '--wait') { opts.wait = Number(rest[i += 1]); }
    else if (a === '--timeout') { opts.timeout = Number(rest[i += 1]); }
    else if (a === '--freeze-baseline') { opts.freezeBaseline = true; }
    else if (a === '--check-baseline') { opts.checkBaseline = true; }
    else if (a === '--force') { opts.force = true; }
    else if (a === '--eds') { opts.eds = true; }
    else if (a === '--retries') { opts.retries = Number(rest[i += 1]); }
    else if (a.startsWith('--')) { throw new UsageError(`unknown flag ${a}`); }
    else pos.push(a);
  }
  const [url, out] = pos;
  if (!url || !out) { throw new UsageError('need <url> and <out.png>'); }
  if (opts.wait == null) opts.wait = opts.settle ? 3000 : 1200;
  return { url, out, opts };
}

// The extra selectors handed to dismissOverlays: the consent selector first, then the dismiss list.
export const overlayExtras = (opts) => [...(opts.consent ? [opts.consent] : []), ...opts.dismiss];
// Scroll target of the chunk starting at y, clamped so the last chunk ends at the document's bottom.
export const chunkTarget = (y, totalH, vh) => Math.max(0, Math.min(y, totalH - vh));
// Scroll-stall guard (chunk loop below): the window did not advance although the target is > 4 px away.
export const scrollStalled = (prevActualY, actualY, target) => prevActualY !== null && actualY <= prevActualY && target - actualY > 4;
// Copy each decoded chunk ({ y, img: { width, height, data } }) into one RGBA buffer of width × totalH;
// rows past totalH and columns past width are dropped.
export function stitchRows(chunks, width, totalH) {
  const out = Buffer.alloc(width * totalH * 4);
  for (const { y: cy, img } of chunks) {
    for (let row = 0; row < img.height; row += 1) {
      const destY = cy + row;
      if (destY >= totalH) break;
      img.data.copy(out, (destY * width) * 4, (row * img.width) * 4, (row * img.width + Math.min(img.width, width)) * 4);
    }
  }
  return out;
}

// ── Origin baseline (opt-in, default OFF) ─────────────────────────────────────────────────────
// One frozen, provenance-stamped origin capture per page × width (baseline.png + baseline.json in the gate
// dir), so a gate round can compare against it instead of a live site that may have changed since the
// last round. The capture itself is the stitch flow in main(); everything here is pure bookkeeping — no
// browser — shared by --freeze-baseline / --check-baseline, the `baseline` and `record` subcommands and
// the tests. Without the flags stitch-shot behaves exactly as before.
export const BASELINE_PNG = 'baseline.png';
export const BASELINE_JSON = 'baseline.json';
export const BASELINE_SCHEMA = 1;
export const BASELINE_WRITER = 'skills/replica/scripts/stitch-shot.mjs --freeze-baseline';
export const LIVE_RECORD_WRITER = { live: 'gate.sh', baseline: 'gate.sh --gate-against-baseline' };

// --freeze-baseline / --check-baseline resolve their targets from <out.png>: a freeze ALWAYS lands in
// <dir>/baseline.png whatever <out.png> was named (a freeze aimed at live.png would otherwise leave the
// round's live shot as the only copy and nothing for baselineExists to find), and a check NEVER writes
// baseline.png (its fresh shot would overwrite the very baseline it compares against — refused before any
// capture). → { out, baselineDir, redirected, refusal }; baselineDir is null without the flags.
export function baselineTargets(out, { freezeBaseline = false, checkBaseline = false } = {}) {
  if (!freezeBaseline && !checkBaseline) return { out, baselineDir: null, redirected: false, refusal: null };
  const baselineDir = dirname(out);
  if (freezeBaseline) {
    const target = join(baselineDir, BASELINE_PNG);
    return { out: target, baselineDir, redirected: target !== out, refusal: null };
  }
  if (basename(out) === BASELINE_PNG) {
    return { out, baselineDir, redirected: false, refusal: `--check-baseline captures a fresh shot to compare against ${BASELINE_PNG} and never writes it — name another output (e.g. ${join(baselineDir, 'live.png')})` };
  }
  return { out, baselineDir, redirected: false, refusal: null };
}

// Both files must exist — a lone baseline.png (an interrupted freeze) is not a baseline.
export function baselineExists(dir) {
  return Boolean(dir) && existsSync(join(dir, BASELINE_PNG)) && existsSync(join(dir, BASELINE_JSON));
}
export function readBaselineProvenance(dir) {
  try { const p = JSON.parse(readFileSync(join(dir, BASELINE_JSON), 'utf8')); return p && typeof p === 'object' ? p : null; } catch { return null; }
}

// baseline.json: when the origin was frozen, for which page (url, width) and under which capture settings
// (vh, settle), what it measured (height, chunks) and whether every declared font face loaded.
export function baselineProvenance({ url, width, vh, height, settle = false, chunks = null, fontsFailed = [], capturedAt = new Date().toISOString() }) {
  return {
    writtenBy: BASELINE_WRITER,
    schema: BASELINE_SCHEMA,
    capturedAt,
    url,
    width: Number(width),
    vh: vh == null ? null : Number(vh),
    height: Number(height),
    settle: Boolean(settle),
    chunks: chunks == null ? null : Number(chunks),
    fontsFailed: Array.isArray(fontsFailed) ? fontsFailed : [],
  };
}

// A JSON file written atomically (sibling temp + rename, pretty, trailing newline): a crash mid-write never
// leaves a half-written record for a later round to read. Used for baseline.json and the round's live.json.
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// Two URLs name the same page when they parse to the same href (a missing trailing slash on an origin, host
// case); unparseable ones compare as strings.
const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } };

// Is there a usable frozen baseline in `dir` for this round? → { ok: true, provenance } or { ok: false, why }
// — the one line gate.sh prints when it refuses: missing, a lone file, unreadable, or stale (frozen for
// another URL or width than the round's, when those are given). A frozen baseline is meant to be old;
// "stale" is only ever "not this page at this width".
export function baselineStatus(dir, { url = null, width = null } = {}) {
  const png = join(dir, BASELINE_PNG); const json = join(dir, BASELINE_JSON);
  const hasPng = existsSync(png); const hasJson = existsSync(json);
  if (!hasPng && !hasJson) return { ok: false, why: `no frozen baseline in ${dir} (${BASELINE_PNG} + ${BASELINE_JSON})` };
  if (!hasJson) return { ok: false, why: `${png} has no ${BASELINE_JSON} beside it (an interrupted freeze) — re-freeze with --force` };
  if (!hasPng) return { ok: false, why: `${json} has no ${BASELINE_PNG} beside it — re-freeze with --force` };
  const provenance = readBaselineProvenance(dir);
  if (!provenance) return { ok: false, why: `${json} is unreadable — re-freeze with --force` };
  if (url && typeof provenance.url === 'string' && !sameUrl(provenance.url, url)) return { ok: false, why: `stale: ${json} was frozen for ${provenance.url}, this round's live URL is ${url} — re-freeze with --force` };
  if (width != null && provenance.width != null && Number(provenance.width) !== Number(width)) return { ok: false, why: `stale: ${json} was frozen at ${provenance.width}px, this round is ${width}px — re-freeze with --force` };
  return { ok: true, provenance };
}

// --check-baseline: a fresh shot's height against the frozen baseline. No verdict — it only says how far the
// origin moved.
export function compareBaseline(baseline, fresh) {
  const bh = typeof baseline?.height === 'number' ? baseline.height : null;
  const fh = typeof fresh?.height === 'number' ? fresh.height : null;
  return { baselineHeight: bh, freshHeight: fh, dHeight: bh != null && fh != null ? fh - bh : null };
}

// The round's live.json — gate.sh's record of which origin live.png is: "baseline" (the frozen origin copied
// over live.png; at = its capturedAt, originBaseline carries its figures) or "live" (a fresh capture). A round
// without --gate-against-baseline retakes a live.png whose record says "baseline"; a live.png with no record is a
// live capture, as it always was.
export function liveRecord({ origin, url, width, at = null, baseline = null }) {
  const rec = { writtenBy: LIVE_RECORD_WRITER[origin], origin, url, width: Number(width) };
  if (origin === 'baseline') {
    const b = baseline && typeof baseline === 'object' ? baseline : {};
    return { ...rec, at: b.capturedAt ?? null, originBaseline: { capturedAt: b.capturedAt ?? null, height: typeof b.height === 'number' ? b.height : null } };
  }
  return { ...rec, at };
}

// `stitch-shot.mjs baseline <dir> [--url <u>] [--width <px>]` (HELP § Origin baseline): the capturedAt or the
// one-line reason on stdout; exit 0 usable, 1 not.
export function baselineCommand(argv) {
  const [dir, ...rest] = argv;
  const usage = (msg) => { console.error(`stitch-shot baseline: ${msg}\n\n${HELP}`); return 1; };
  if (!dir || dir.startsWith('--')) return usage('needs <dir>');
  const o = { url: null, width: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]; const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) return usage(`${a} needs a value`);
    if (a === '--url') o.url = v; else if (a === '--width') o.width = v; else return usage(`unknown flag ${a}`);
    i += 1;
  }
  if (o.width != null && !/^\d+$/.test(o.width)) return usage('--width needs a whole number of px');
  const s = baselineStatus(dir, o);
  process.stdout.write(`${s.ok ? String(s.provenance.capturedAt || 'unknown') : s.why}\n`);
  return s.ok ? 0 : 1;
}

// `stitch-shot.mjs record <live.json> --origin live|baseline --url <u> --width <px> [--baseline <json>] [--at <iso>]`
// (HELP § Origin baseline): the round's live.json, written atomically. Exit 0 written; 1 usage.
export function recordCommand(argv) {
  const [file, ...rest] = argv;
  const usage = (msg) => { console.error(`stitch-shot record: ${msg}\n\n${HELP}`); return 1; };
  if (!file || file.startsWith('--')) return usage('needs <live.json>');
  const o = { origin: null, url: null, width: null, baseline: null, at: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]; const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) return usage(`${a} needs a value`);
    if (a === '--origin') o.origin = v; else if (a === '--url') o.url = v; else if (a === '--width') o.width = v;
    else if (a === '--baseline') o.baseline = v; else if (a === '--at') o.at = v;
    else return usage(`unknown flag ${a}`);
    i += 1;
  }
  if (!LIVE_RECORD_WRITER[o.origin]) return usage('--origin must be live or baseline');
  if (!o.url || !o.width || !/^\d+$/.test(o.width)) return usage('--url <u> and --width <px> are required');
  if (o.origin === 'baseline' && !o.baseline) return usage('--origin baseline needs --baseline <baseline.json>');
  let baseline = null;
  if (o.baseline) {
    try { baseline = JSON.parse(readFileSync(o.baseline, 'utf8')); } catch (e) { return usage(`cannot read ${o.baseline} (${e.message})`); }
  }
  writeJsonAtomic(file, liveRecord({ origin: o.origin, url: o.url, width: o.width, at: o.at, baseline }));
  return 0;
}

// Dismiss both overlay classes (consent + timed marketing modals) via
// live-session, log what was closed, and note that the mouse is parked by
// dismissOverlays itself (bottom-left — rule 10).
async function dismissAndLog(page, url, opts, log = console.log) {
  const extra = overlayExtras(opts);
  // late-modal poll window only on live targets — the served prototype's
  // overlays are not timed third-party scripts, they render immediately.
  const d = await dismissOverlays(page, { extra, lateWindowMs: isLiveHttpUrl(url) ? 6000 : 0 });
  if (d.consent) log(`consent dismissed via ${d.consent}`);
  for (const sel of d.extra) log(`overlay dismissed via extra selector ${sel}`);
  for (const sel of d.marketing) log(`marketing modal dismissed via ${sel}`);
  return d;
}

// <out.png> → the record beside it (live.png → live.capture.json).
export const sidecarOf = (out) => `${out.replace(/\.png$/i, '')}.capture.json`;

// gotoLive reads the entry for a 2xx denial page; this reads the page once more after the dismissal sweep(s) — a
// denial page a script renders after domcontentloaded. A marker → BotChallengeError (exit 3), with the entry's
// status. Returns capture.json's denialCheck: 'ok' (read, no marker) | 'skipped: <reason>' (the probe failed twice,
// or a live-session.mjs copy that predates pageDenial) — a skip is one stderr line AND on the record, never a
// silent pass.
export async function recheckDenial(session, page, url, status) {
  if (typeof session.pageDenial !== 'function' || typeof session.botChallengeError !== 'function') {
    console.error('stitch-shot: denial-page check skipped (live-session.mjs predates pageDenial — copy the diff skill\'s live-session.mjs alongside)');
    return 'skipped: live-session.mjs predates pageDenial';
  }
  const { marker, skipped } = await session.pageDenial(page);
  if (skipped) console.error(`stitch-shot: denial-page check skipped (${skipped})`);
  if (marker) throw session.botChallengeError(url, `HTTP ${status} ${marker}`, { denial: true });
  return skipped ? `skipped: ${skipped}` : 'ok';
}

// exit 3 = bot challenge on the live side — an edge interstitial or a 2xx denial page (distinct from generic errors,
// so a gate runner can tell "blocked — escalate with --headed" from "capture broke"); exit 5 = --eds and the served
// page stayed undecorated or answered 429 / 5xx through every retry (never shot — the row is an error, not a FAIL).
export const exitCodeFor = (e) => (e && e.name === 'BotChallengeError' ? 3 : e && e.name === 'EdsNotReadyError' ? 5 : 1);

/**
 * One stitched capture on an open page (the CLI and gate-all's in-process workers share it, #141) →
 * { pngBuf, height, chunks, denialCheck, failedFonts }. Nothing is written. With opts.eds the served page must be
 * decorated (live-session edsReady) and free of 429 / 5xx responses on its host, else EdsNotReadyError (retryable:
 * withServedRetry); opts.freezeBaseline stops before the chunk loop when fonts failed (failedFonts set, no pngBuf).
 */
export async function captureStitched(page, url, opts, { PNG, log = console.log, warn = console.error } = {}) {
  const watch = opts.eds ? liveSession.watchServed(page, url) : null;
  const notReady = (ready) => { const why = liveSession.readinessReason({ bad: watch.bad, ready }); if (why) throw new liveSession.EdsNotReadyError(why); };
  try {
    // Challenge/blocked interstitial → loud BotChallengeError (exit 3); a challenge page must never be stitched as if
    // it were the source. solveWindow only under --headed: headless clearance never lands, and the solve loop would
    // spend the Akamai block budget (1 hit vs up to 4).
    const entry = await gotoLive(page, url, { waitUntil: 'domcontentloaded', timeoutMs: opts.timeout, settleMs: 0, solveWindow: opts.headed });
    await page.waitForTimeout(opts.wait);
    if (watch) notReady(await liveSession.edsReady(page));
    // --no-dismiss: the capture shows whatever the site shows (the gate's --no-dismiss reaches both sides).
    if (opts.noDismiss) log('overlays left as the page shows them (--no-dismiss)');
    else await dismissAndLog(page, url, opts, log);

    if (opts.settle) {
      // Slow-scroll settle: fires scroll-triggered lazy loaders the way a real visit does. Do NOT force data-src→src
      // swaps: on CDN-defended sites the forced rendition requests 403 and produce broken-image icons — worse than
      // the site's own designed placeholders. Ground truth is the page as observable by this instrument.
      await page.evaluate(async () => {
        for (let y = 0; y <= document.body.scrollHeight; y += 300) {
          window.scrollTo(0, y);
          await new Promise((r) => { setTimeout(r, 220); });
        }
      });
      await page.waitForTimeout(3000);
      // Timed marketing/newsletter modals (CH-1) often fire DURING the settle window — sweep again so a late
      // interstitial isn't baked into the stitched capture (recorded: a fashion retailer's "Sign up, stay updated!").
      if (!opts.noDismiss) await dismissAndLog(page, url, opts, log);
    }
    // lazy sections and blocks load during the settle: a 429 there leaves them undecorated too
    if (watch) notReady(await liveSession.edsReady(page, { timeoutMs: 8000 }));

    // A denial page a script rendered after domcontentloaded (gotoLive read the entry): exit 3, no PNG, no sidecar.
    const denialCheck = await recheckDenial(liveSession, page, url, entry.status());

    // Freeze animations/transitions/carets for stable chunks — AFTER settle.
    await page.addStyleTag({ content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important;}html{scroll-behavior:auto!important}' });
    // The CSS freeze stabilizes CSS animations only. It does NOT stop (a) <video> playback — autoplaying teaser
    // videos capture an arbitrary frame per run; (b) JS-timer carousels (slick autoplay swaps slides mid-capture).
    // Applied symmetrically to both sides: pause every video at t=0 and clear all pending timeouts/intervals. Runs
    // AFTER settle, so clearing timers can't starve lazyload.
    await page.evaluate(async () => {
      const vids = [...document.querySelectorAll('video')];
      await Promise.all(vids.map((v) => new Promise((res) => {
        try {
          v.pause();
          v.removeAttribute('autoplay');
          if (v.readyState >= 1) { v.currentTime = 0; }
          if (v.seeking) { v.addEventListener('seeked', () => res(), { once: true }); setTimeout(res, 1500); }
          else { setTimeout(res, 200); }
        } catch { res(); }
      })));
      let id = window.setTimeout(() => {}, 0);
      while (id-- > 0) { window.clearTimeout(id); window.clearInterval(id); }
    });
    // Carousel t=0 determinism: clicking the first slick-convention dot resets BOTH sides to slide 1 (transitions are
    // frozen, so the reset is instant and symmetric); timers are cleared again because slick re-arms its autoplay.
    await page.evaluate(() => {
      const dot = document.querySelector('.slick-dots li:first-child button');
      if (dot) {
        dot.click();
        let id = window.setTimeout(() => {}, 0);
        while (id-- > 0) { window.clearTimeout(id); window.clearInterval(id); }
      }
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);

    // Font-load assertion (F-B2 companion): a webfont that failed to fetch renders the ENTIRE capture in fallback type
    // with no error anywhere. Not a hard exit: source-fidelity-gate.md § Hardening rule 14 owns the decision procedure.
    const failedFonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...new Set([...document.fonts].filter((f) => f.status === 'error').map((f) => f.family))];
    }).catch(() => []);
    if (failedFonts.length) {
      warn(`stitch-shot WARNING: FONT LOAD FAILED for declared face(s) ${failedFonts.join(', ')} — this capture renders fallback type (silent false measurement, F-B2 class). Verify the face loads in a real browser: instrument-induced → fix the capture before gating; genuinely broken on the live site → log as capture-state.`);
    }
    // --freeze-baseline never freezes a capture whose fonts failed (the caller refuses, nothing written).
    if (opts.freezeBaseline && failedFonts.length) return { pngBuf: null, failedFonts, denialCheck };

    // Height is measured AFTER the settle pass, never before: entrance-animated sites inflate scrollHeight until
    // elements go inview (recorded: 3183px pre-settle vs 3093px settled).
    const totalH = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    if (!totalH || totalH < 10) throw new Error(`page height ${totalH}px — blank render? (bot challenge / hidden body)`);

    const chunks = [];
    let y = 0;
    let prevActualY = null;
    while (y < totalH) {
      const target = chunkTarget(y, totalH, opts.vh);
      await page.evaluate((ty) => window.scrollTo(0, ty), target);
      await page.waitForTimeout(450);
      // wait for in-viewport images to complete (max 3s per chunk)
      await page.evaluate(async () => {
        const t0 = Date.now();
        const pend = () => [...document.querySelectorAll('img')].some((i) => {
          const r = i.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight && r.width > 10 && (!i.complete || i.naturalWidth === 0);
        });
        while (pend() && Date.now() - t0 < 3000) await new Promise((r) => { setTimeout(r, 150); });
      });
      const actualY = await page.evaluate(() => window.scrollY);
      // Scroll-stall guard: on inner-scroller / scroll-jacked pages window.scrollTo is a NO-OP and every chunk would
      // capture the top viewport (silent black bands). The 4px slack absorbs fractional-pixel scroll rounding.
      if (scrollStalled(prevActualY, actualY, target)) {
        throw new Error(`scroll stall at chunk target ${target}px: window scroll is a no-op (window.scrollY stuck at ${actualY}px) while the document reports ${totalH}px — likely an inner scroll container / scroll-jacked layout (html/body overflow:hidden). Stitched capture cannot measure this page class (capturing the inner scroller is future work): record the page as gate-blocked for the pixel probe and rely on content-diff/visual-diff.`);
      }
      prevActualY = actualY;
      const buf = await page.screenshot();
      chunks.push({ y: actualY, buf });
      y += opts.vh;
    }
    if (watch) notReady(null);

    const outPng = new PNG({ width: opts.width, height: totalH });
    outPng.data = stitchRows(chunks.map(({ y: cy, buf }) => ({ y: cy, img: PNG.sync.read(buf) })), opts.width, totalH);
    return { pngBuf: PNG.sync.write(outPng), height: totalH, chunks: chunks.length, denialCheck, failedFonts };
  } finally { if (watch) watch.stop(); }
}

/** The capture record beside <out.png> (the CLI and gate-all write the same shape). */
export const captureRecord = (url, opts, r) => ({ writtenBy: 'skills/replica/scripts/stitch-shot.mjs', url, width: opts.width, vh: opts.vh, height: r.height, chunks: r.chunks, denialCheck: r.denialCheck, at: new Date().toISOString() });

async function main() {
  // The browserless subcommands gate.sh calls (HELP § Origin baseline) — before parseArgs, which needs <url> <out.png>.
  const sub = process.argv[2];
  if (sub === 'record' || sub === 'baseline') process.exit(sub === 'record' ? recordCommand(process.argv.slice(3)) : baselineCommand(process.argv.slice(3)));
  const { url, out: given, opts } = parseArgs(process.argv);
  // --freeze-baseline / --check-baseline: the targets are settled before any capture — a freeze always lands in
  // <dir>/baseline.png (never the given live.png), a check never writes baseline.png (refused, exit 2), a
  // re-freeze over an existing baseline refuses without --force. Without the flags `out` is the given path.
  const targets = baselineTargets(given, opts);
  if (targets.refusal) { console.error(`stitch-shot: ${targets.refusal}`); process.exit(2); }
  if (targets.redirected) console.error(`stitch-shot: --freeze-baseline writes the frozen origin baseline to ${targets.out}, not ${given} (live.png is a round's live shot, never a freeze target)`);
  const { out, baselineDir } = targets;
  if (opts.freezeBaseline && baselineExists(baselineDir) && !opts.force) {
    const prev = readBaselineProvenance(baselineDir);
    console.error(`stitch-shot: a frozen baseline already exists in ${baselineDir} (captured ${prev?.capturedAt ?? 'unknown'}) — pass --force to re-freeze`);
    process.exit(2);
  }
  // The capture record beside <out.png>; a freeze writes baseline.json instead and leaves no capture record.
  const sidecar = opts.freezeBaseline ? null : sidecarOf(out);
  if (sidecar) rmSync(sidecar, { force: true }); // a refused or failed capture leaves no record of an earlier one
  // Lazy: --help, the subcommands, the refusals above and the pure tests need neither playwright nor pngjs.
  let chromium; let PNG;
  try { ({ chromium } = await import('playwright')); ({ PNG } = await import('pngjs')); } catch (e) { throw new Error(`playwright / pngjs not importable from ${HERE} (${e.code || e.message}) — replica SKILL.md § Setup: copy the scripts dir into the project and run the copy`); }
  const browser = opts.headed ? await launchStealthHeaded(chromium) : await chromium.launch();
  try {
    // UA + standard headers + webdriver spoof on the context (live-session).
    const ctx = await newLiveContext(browser, { ua: opts.ua, locale: opts.locale, viewport: { width: opts.width, height: opts.vh } });
    const r = await liveSession.withServedRetry(async () => {
      const page = await ctx.newPage();
      try { return await captureStitched(page, url, opts, { PNG }); } finally { await page.close().catch(() => {}); }
    }, { retries: opts.eds ? opts.retries : 0, onRetry: (e, i, ms) => console.error(`stitch-shot: ${e.message} — retry ${i + 1}/${opts.retries} in ${ms} ms`) });
    // --freeze-baseline never freezes a capture whose fonts failed: a baseline in fallback type would bake the
    // wrong wraps and heights into every later round. Nothing is written — fix the capture, then re-freeze.
    if (!r.pngBuf) {
      console.error(`stitch-shot: not freezing a baseline — the capture's font load failed (${r.failedFonts.join(', ')}); fix the capture, then re-freeze`);
      process.exitCode = 2;
      return;
    }
    mkdirSync(dirname(out), { recursive: true });
    // --freeze-baseline writes baseline.png atomically (sibling temp + rename): a crash mid-write never leaves a
    // torn PNG a gate round would read as the origin. A normal capture keeps the plain write.
    if (opts.freezeBaseline) { const tmp = `${out}.${process.pid}.tmp`; writeFileSync(tmp, r.pngBuf); renameSync(tmp, out); }
    else writeFileSync(out, r.pngBuf);
    if (opts.freezeBaseline) {
      writeJsonAtomic(join(baselineDir, BASELINE_JSON), baselineProvenance({ url, width: opts.width, vh: opts.vh, height: r.height, settle: opts.settle, chunks: r.chunks, fontsFailed: r.failedFonts }));
      console.log(`froze origin baseline in ${baselineDir}: ${BASELINE_PNG} + ${BASELINE_JSON} (${opts.width}x${r.height}px)`);
    }
    if (sidecar) writeFileSync(sidecar, `${JSON.stringify(captureRecord(url, opts, r), null, 2)}\n`);
    if (opts.checkBaseline) {
      const base = readBaselineProvenance(baselineDir);
      if (!base) console.log(`check-baseline: no frozen baseline in ${baselineDir} — freeze one first (nothing to compare)`);
      else {
        const d = compareBaseline(base, { height: r.height });
        const dh = d.dHeight === null ? 'unknown' : `${d.dHeight >= 0 ? '+' : ''}${d.dHeight}px`;
        console.log(`check-baseline ${baselineDir}: Δheight ${dh} (baseline ${d.baselineHeight ?? '?'} → fresh ${d.freshHeight}; frozen ${base.capturedAt ?? 'unknown'})`);
      }
    }
    console.log(`stitched ${out}: ${opts.width}x${r.height} from ${r.chunks} chunks`);
  } finally {
    await browser.close();
  }
}

// Main-module guard by real path (a symlinked checkout or temp dir must not turn the CLI into a silent no-op): the
// test imports the helpers above without starting a capture.
function safeRealpath(p) { try { return realpathSync(p); } catch { return p; } }
if (process.argv[1] && fileURLToPath(import.meta.url) === safeRealpath(process.argv[1])) {
  main().catch((e) => {
    if (e instanceof UsageError) { console.error(`${e.message}\n\n${HELP}`); process.exit(1); }
    console.error(`stitch-shot error: ${e.message}`); process.exit(exitCodeFor(e));
  });
}
