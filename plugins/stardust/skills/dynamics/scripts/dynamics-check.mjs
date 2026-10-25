#!/usr/bin/env node
/**
 * dynamics-check.mjs — stardust:dynamics Phase 5: replay the dynamic parity
 * checks against the published origin. Read-only. Flows, not presence: a check
 * passes when the user-visible flow completes (a query returns a known answer, an
 * empty submission is refused and a filled one reaches the endpoint, a player
 * actually plays), never because a block rendered.
 *
 * Input: `stardust/dynamics/parity.json` (reference/parity-report.md) — per feature
 * a `checks[]` list from the closed set below. Also exported as `replay()` for the
 * qa `dynamics` check.
 *
 *   node dynamics-check.mjs --origin https://main--site--org.aem.live [--parity stardust/dynamics/parity.json]
 *        [--contract stardust/martech-contract.json] [--out stardust/qa] [--auth-header "token …" | --token-env SITE_TOKEN] [--headed]
 *
 * Writes (under --out, default stardust/qa):
 *   dynamics-report.md     one row per replayed check (PASS/FAIL, detail, third-party requests)
 *   dynamics-report.json   the same results with _provenance
 * Progress lines go to stderr. Exit 0 when every check passed, 1 otherwise, 2 on usage.
 *
 * Check types (* = required):
 *   fetch-json     { url*, minRows?, expectKeys? }                 GET on the origin returns JSON with rows / keys
 *   dom-count      { path*, selector*, min* }                      ≥ min elements after settle
 *   click-dialog   { path*, trigger*, headingIncludes?, minWidth? } click opens a dialog; heading / width asserted; Escape closes it
 *   search-query   { path*, param?, term*, resultSelector*, titleSelector?, expectIncludes?, expectCount?, expectTitles?[], countTolerance? }
 *                  the results are compared with what the SOURCE showed for the same term (read during detect,
 *                  recorded here — at least one expectation): a result includes expectIncludes; the result COUNT
 *                  equals expectCount (± countTolerance, default 0); the top titles (≤ 3) equal expectTitles as a
 *                  set; no two results share title + text. A count mismatch FAILS — a recorded hands-off run's
 *                  typeahead returned 10 entries (two home pages under one title) where the source returned 3.
 *                  Exported as `compareSearchResults(results, check)` for the unit test and the qa check.
 *   runtime-list   { path*, block*, source*, itemSelector?, nth?, sheet?, key?, match?, prefix?[], filter?, require?, sort?, order?, offset?, limit?,
 *                    excludeSelf?, itemPattern?, expectItems?[] }
 *                  an index-backed / data-fed list renders from its SOURCE at runtime (dynamics triage rule 10): FAIL when the
 *                  block (`block` = its class tokens, `nth` instance) carries the items in `<path>.plain.html`, when the page never
 *                  requests `source`, or when the rendered items (`itemSelector` inside the block, default `a[href]`) differ from
 *                  the rule applied to the source rows — `prefix` paths, `filter` { field: value | [values] | "{self}" = the
 *                  page's own row value, empty = unfiltered }, `require` fields a row must carry, `excludeSelf`, `sort` field
 *                  `order` desc|asc (none = source order: a curated sheet), `offset`, `limit`. Identity: `key` (default path) by href path, or `match: "text"`.
 *                  `expectItems` = what the SOURCE showed: the delivered ones must keep its order; a partial migration
 *                  delivers a subset, so coverage is reported, not failed. Pure parts exported: `applyListRule`,
 *                  `authoredItems`, `judgeRuntimeList`, `missingListChecks` (an index-backed / data-fed class L or R
 *                  feature without a runtime-list check fails).
 *   form-flow      { path*, form?, submit*, fill*, statusSelector?, endpointPattern?, successIncludes? } empty submit refused, filled submit arrives
 *   video-plays    { path*, trigger?, iframeSelector?, videoSelector?, playbackHost?, reducedMotionPauses? }
 *                  PLAYBACK, not presence: a vendor iframe must issue a playback request to playbackHost with
 *                  status < 400; a native <video> (scrolled to ≥ ¼ visible) must be PLAYING — not paused,
 *                  currentTime advancing between two samples; with reducedMotionPauses the page is reloaded
 *                  under prefers-reduced-motion and the video must be paused. "Video elements present and
 *                  controllable" passed 26/26 on a recorded run while nothing played — the capture freeze
 *                  (video at t=0) had become the spec. Exported as `judgeVideoPlayback(sample, check)`.
 *   consent-gate   { path*, forbiddenHosts*[] }                    no request to those hosts before consent
 *   martech        { path*, mode*: gate|accept, forbiddenHosts?[], expect?[{ id, hosts[] }], productionHosts?[] }
 *                  gate: no forbiddenHosts host is requested; accept: each expected id requests one of its hosts.
 *                  Cross-site requests are aborted once their host is recorded, so a replay never sends a hit to a
 *                  production account; skipped on a production host. Built by `martechChecks(contract)`.
 *   no-page-errors { paths*[] }                                    no uncaught exceptions
 * Every check also records the third-party request statuses it observed, so a
 * probe-induced failure is distinguishable from a vendor restriction.
 *
 * --contract (default: stardust/martech-contract.json when it exists, written only by `dynamics-plan --martech`)
 * appends the martech feature; with a contract and no parity file only the martech checks run.
 */
/* eslint-disable no-await-in-loop, no-restricted-syntax, max-len */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { arg, flag, readJSON, writeJSON, writeText, provenance, loadPlaywright, resolveAuthHeader, attachOriginAuth, sameSite } from './lib.mjs';

const settle = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function openPage(ctx, origin, path) {
  const page = await ctx.newPage();
  const errors = []; const thirdParty = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  page.on('response', (r) => { try { const u = new URL(r.url()); if (!sameSite(u.host, new URL(origin).host) && thirdParty.length < 60) thirdParty.push({ host: u.host, status: r.status(), type: r.request().resourceType() }); } catch { /* ignore */ } });
  await page.goto(origin + path, { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => { await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 60000 }); });
  await settle(1200);
  return { page, errors, thirdParty };
}
const summarize = (tp) => { const m = {}; for (const t of tp) { const k = `${t.host}:${t.status}`; m[k] = (m[k] || 0) + 1; } return Object.entries(m).slice(0, 12).map(([k, n]) => `${k}×${n}`).join(' '); };
const DIALOG = 'dialog[open], [role=dialog]:not([hidden]), [aria-modal=true]';

/**
 * Compare a results list `[{ title, text, href }]` with the expectations recorded from the SOURCE
 * for the same term: `expectIncludes` (a result carries this text/href), `expectCount` (the
 * source's result count, ± `countTolerance`, default 0), `expectTitles` (the source's top titles;
 * the first ≤ 3 are compared as a set with the top results here). Two results sharing title + text
 * are duplicates and fail. Pure — no browser, no network — so the unit test drives it directly.
 * Returns { pass, detail, reasons[] }.
 */
// Two reads of the first matching <video>, 800 ms apart, after scrolling it to the viewport centre.
// Null when the page has no such element.
async function sampleVideo(page, selector) {
  const read = () => page.evaluate((s) => {
    const v = document.querySelector(s);
    if (!v) return null;
    const r = v.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)) / (r.height || 1);
    return { autoplay: v.hasAttribute('autoplay'), paused: v.paused, t: v.currentTime, readyState: v.readyState, visible: Math.round(visible * 100) / 100, src: (v.currentSrc || v.src || '').slice(0, 160) };
  }, selector);
  const found = await page.evaluate((s) => { const v = document.querySelector(s); if (v) v.scrollIntoView({ block: 'center' }); return !!v; }, selector);
  if (!found) return null;
  await settle(1500);
  const a = await read();
  await settle(800);
  const b = await read();
  return { found: true, autoplay: a.autoplay, src: a.src, visible: b.visible, readyState: b.readyState, paused: b.paused, t0: a.t, t1: b.t };
}

// Pure verdict for `video-plays`: sample = { iframe, video, reduced, vendorOk, vendorRequests } where
// video/reduced are sampleVideo() results (null = no <video>). Presence alone never passes.
export function judgeVideoPlayback({ iframe = false, video = null, reduced = null, vendorOk = false, vendorRequests = 0 } = {}, check = {}) {
  const reasons = [];
  const playing = !!video && !video.paused && video.t1 > video.t0;
  if (video && !playing) reasons.push(`video not playing (paused ${video.paused}, Δt ${(video.t1 - video.t0).toFixed(2)}s, readyState ${video.readyState}, ${Math.round((video.visible || 0) * 100)}% visible)`);
  if (video && reduced && (!reduced.paused || reduced.t1 > reduced.t0)) reasons.push('video plays under prefers-reduced-motion');
  if (check.playbackHost && !vendorOk) reasons.push(`no playback request to ${check.playbackHost} with status < 400 (${vendorRequests} seen)`);
  if (!video && !iframe) reasons.push('no player: neither a vendor iframe nor a <video> found');
  const detail = [`iframe/video: ${iframe}`, video ? `video ${playing ? 'playing' : 'NOT playing'} (Δt ${(video.t1 - video.t0).toFixed(2)}s)` : 'no <video>',
    check.playbackHost ? `playback requests ${vendorRequests} (${vendorOk ? 'ok' : 'none ok'})` : null, reduced ? `reduced-motion: ${reduced.paused ? 'paused' : 'PLAYING'}` : null]
    .filter(Boolean).join(' · ');
  return { pass: reasons.length === 0, playing, reasons, detail: reasons.length ? `${detail} · ${reasons.join('; ')}` : detail };
}

export function compareSearchResults(results, { expectIncludes, expectCount, expectTitles, countTolerance = 0 } = {}) {
  const norm = (x) => String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const rows = (Array.isArray(results) ? results : []).map((r) => (typeof r === 'string' ? { title: norm(r), text: norm(r), href: '' } : { title: norm(r.title), text: norm(r.text), href: norm(r.href) }));
  const hasCount = expectCount !== undefined && expectCount !== null && expectCount !== '' && Number.isFinite(Number(expectCount));
  const wantCount = hasCount ? Number(expectCount) : null;
  const titles = Array.isArray(expectTitles) ? expectTitles.map(norm).filter(Boolean) : [];
  const reasons = [];
  if (!expectIncludes && !hasCount && !titles.length) reasons.push('no expectation recorded (expectIncludes | expectCount | expectTitles)');
  if (!rows.length && !(hasCount && wantCount === 0)) reasons.push('no results');
  if (expectIncludes) {
    const needle = norm(expectIncludes);
    if (!rows.some((r) => `${r.title} ${r.text} ${r.href}`.includes(needle))) reasons.push(`expected "${expectIncludes}" MISSING`);
  }
  if (hasCount) {
    const tol = Math.max(0, Number(countTolerance) || 0);
    if (Math.abs(rows.length - wantCount) > tol) reasons.push(`count ${rows.length} vs source ${wantCount}${tol ? ` (±${tol})` : ''}`);
  }
  if (titles.length) {
    const n = Math.min(3, titles.length);
    const want = titles.slice(0, n); const got = rows.slice(0, n).map((r) => r.title);
    const missing = want.filter((t) => !got.includes(t)); const unexpected = got.filter((t) => !want.includes(t));
    if (missing.length || unexpected.length) reasons.push(`top-${n} titles differ — source: ${want.join(' | ')} · here: ${got.join(' | ') || '(none)'}`);
  }
  const seen = new Set(); const dupes = [];
  for (const r of rows) { const k = `${r.title}|${r.text}`; if (seen.has(k)) { if (!dupes.includes(r.title)) dupes.push(r.title); } else seen.add(k); }
  if (dupes.length) reasons.push(`duplicates (title + text): ${dupes.slice(0, 3).map((d) => `"${d.slice(0, 40)}"`).join(', ')}`);
  const summary = `${rows.length} results${hasCount ? ` (source ${wantCount})` : ''}${rows[0] ? ` · first: ${rows[0].title.slice(0, 60)}` : ''}`;
  return { pass: reasons.length === 0, detail: reasons.length ? `${summary} · ${reasons.join(' · ')}` : `${summary} · matches the source`, reasons };
}

const DEFAULT_CONTRACT = 'stardust/martech-contract.json';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/** off by default: nothing on `/`; with `?martech=on` a category-gated route waits for consent; enabled ones load on accept.
 * The Web SDK (`aemMartech`) counts as one more route whose host is its edge domain. */
export function martechChecks(contract) {
  const { cmp } = contract.consent || {};
  const am = contract.aemMartech;
  const routes = [...(contract.routes || []), ...(am ? [{ id: 'aem-martech', edge: am.config?.edgeDomain || am.plugin?.edge || 'edge.adobedc.net', category: am.category, enabled: am.enabled }] : [])];
  const enabled = routes.filter((r) => r.enabled);
  const base = { type: 'martech', productionHosts: contract.productionHosts || [] };
  const host = (r) => r.edge || hostOf(r.src);
  const checks = [{ ...base, path: '/', mode: 'gate', forbiddenHosts: [...new Set([...routes.map(host), hostOf(cmp?.src)])].filter(Boolean).sort() }];
  const gated = enabled.filter((r) => r.category).map(host);
  if (gated.length) checks.push({ ...base, path: '/?martech=on', mode: 'gate', forbiddenHosts: [...new Set(gated)].sort() });
  const expect = [...(cmp?.enabled ? [{ id: 'cmp', hosts: [hostOf(cmp.src)] }] : []), ...enabled.map((r) => ({ id: r.id, hosts: [host(r)] }))];
  if (expect.length) checks.push({ ...base, path: '/?martech=on&consent=accept', mode: 'accept', expect });
  return { id: 'martech', feature: 'martech: consent + tag routing', class: 'T', status: enabled.length || cmp?.enabled ? 'owner-enabled' : 'scaffolded-off', checks };
}

export function judgeMartechRequests(hosts, c) {
  const hits = (p) => hosts.filter((h) => h === p || h.endsWith(`.${p}`));
  if (c.mode === 'gate') {
    const leaked = [...new Set((c.forbiddenHosts || []).flatMap(hits))];
    return { pass: leaked.length === 0, detail: leaked.length ? `tags fired without consent: ${leaked.join(', ')}` : `no tag host requested (${(c.forbiddenHosts || []).length} gated · ${hosts.length} cross-site host(s) blocked)` };
  }
  const expect = c.expect || [];
  const missing = expect.filter((g) => !g.hosts.some((p) => hits(p).length));
  return { pass: expect.length > 0 && missing.length === 0, detail: missing.length ? `not requested after consent: ${missing.map((g) => `${g.id} (${g.hosts.join(' | ')})`).join(', ')}` : `${expect.length} route(s) requested after consent` };
}

/* ---------------------------------------------------- runtime-list (#144) ---- */
const LIST_DISPOSITIONS = new Set(['index-backed', 'data-fed']);
const LIST_CLASSES = new Set(['L', 'R']);
const squashText = (x) => String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** href or path → '/a/b' (host, query, hash and trailing slash dropped); a non-URL value comes back squashed. */
export const listPath = (u) => {
  const v = String(u ?? '').trim();
  if (!v) return '';
  try { const p = new URL(v, 'https://x.invalid').pathname.replace(/\/+$/, ''); return p || '/'; } catch { return squashText(v); }
};
const identity = (v, match) => (match === 'text' ? squashText(v) : listPath(v));

/** Rows of a source document: `{ data }` (query index, one sheet), `{ <sheet>: { data } }` (multi-sheet) or `{ <sheet>: [...] }`
 * (a snapshot's named array) by `sheet`, a bare array. */
export function sourceRows(json, sheet = null) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  if (sheet && Array.isArray(json[sheet])) return json[sheet]; // a snapshot's named array ({ topics: [...] })
  if (sheet && json[sheet] && Array.isArray(json[sheet].data)) return json[sheet].data;
  return Array.isArray(json.data) ? json.data : [];
}

/** The list rule applied to the source rows → the rows the page must render, in order. */
export function applyListRule(rows, { path = '', key = 'path', prefix = [], filter = {}, require = [], excludeSelf = false, sort = null, order = 'desc', offset = 0, limit = null } = {}) {
  const self = listPath(path);
  const own = rows.find((r) => listPath(r[key]) === self) || {};
  const prefixes = [].concat(prefix || []).filter(Boolean);
  const values = (r, field) => String(r[field] ?? '').split(',').map(squashText).filter(Boolean);
  const wants = Object.entries(filter || {}).map(([field, v]) => [field, v === '{self}' ? values(own, field) : [].concat(v).map(squashText).filter(Boolean)]).filter(([, vs]) => vs.length);
  const needs = [].concat(require || []).flatMap((f) => String(f).split(',')).map((f) => f.trim()).filter(Boolean);
  let out = rows.filter((r) => (!prefixes.length || prefixes.some((p) => listPath(r[key]).startsWith(p)))
    && needs.every((f) => String(r[f] ?? '').trim())
    && wants.every(([field, vs]) => values(r, field).some((x) => vs.includes(x)))
    && !(excludeSelf && listPath(r[key]) === self));
  if (sort) {
    const val = (r) => { const x = r[sort]; const n = Number(x); return Number.isFinite(n) && String(x).trim() !== '' ? n : (Date.parse(x) || 0); };
    out = out.map((r, i) => ({ r, i })).sort((a, b) => (order === 'asc' ? val(a.r) - val(b.r) : val(b.r) - val(a.r)) || a.i - b.i).map((x) => x.r);
  }
  out = out.slice(Math.max(0, Number(offset) || 0));
  if (limit !== null && limit !== undefined && limit !== '') out = out.slice(0, Math.max(0, Number(limit)));
  return out;
}

/** Outer HTML of every element whose class list holds all of `tokens` (plain-HTML string scan, balanced on the tag). */
export function blocksIn(html, tokens) {
  const want = String(tokens || '').split(/\s+/).filter(Boolean);
  const out = [];
  const re = /<(div|section|ul|ol)\b[^>]*\bclass="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cls = m[2].split(/\s+/);
    if (!want.every((t) => cls.includes(t))) continue;
    const tag = m[1].toLowerCase();
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = m.index;
    let depth = 0; let t; let end = html.length;
    while ((t = tagRe.exec(html))) { depth += t[1] ? -1 : 1; if (depth === 0) { end = tagRe.lastIndex; break; } }
    out.push(html.slice(m.index, end));
  }
  return out;
}

/** Item identities found AUTHORED inside the block instance in the served document: source rows or expected items it names. */
export function authoredItems(plainHtml, check = {}, rows = []) {
  const { block, nth = 0, key = 'path', match = 'path', itemPattern = null, expectItems = [] } = check;
  const html = blocksIn(plainHtml || '', block)[nth] || '';
  if (!html) return [];
  // the rows the list could show (its pool: prefix, require, filter — no slice), not every row of the source
  const pool = applyListRule(rows, { ...check, offset: 0, limit: null, excludeSelf: false });
  const known = new Set([...pool.map((r) => identity(r[key], match)), ...expectItems.map((x) => identity(x, match))].filter(Boolean));
  const pattern = itemPattern ? new RegExp(itemPattern) : null;
  const found = new Set();
  if (match === 'text') {
    const text = squashText(html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '));
    known.forEach((k) => { if (k && text.includes(k)) found.add(k); });
  } else {
    for (const a of html.matchAll(/\bhref="([^"]*)"/gi)) {
      const p = listPath(a[1].replace(/&amp;/g, '&'));
      if (known.has(p) || (pattern && pattern.test(a[1]))) found.add(p);
    }
  }
  return [...found];
}

/** Verdict of one runtime-list check from what the replay saw. Pure. */
export function judgeRuntimeList({ authored = [], requested = false, rendered = [], rows = [] } = {}, check = {}) {
  const { match = 'path', key = 'path' } = check;
  const reasons = [];
  if (authored.length) reasons.push(`items authored in the document: ${authored.length} (${authored.slice(0, 3).join(', ')}) — the block must render them from ${check.source}`);
  if (!requested) reasons.push(`the page never requested ${check.source}`);
  const expected = applyListRule(rows, check).map((r) => identity(r[key], match));
  const got = rendered.map((x) => identity(x, match)).filter(Boolean);
  if (expected.join('|') !== got.join('|')) reasons.push(`rendered ≠ the rule over the source: expected [${expected.slice(0, 6).join(', ')}${expected.length > 6 ? ', …' : ''}] (${expected.length}) · rendered [${got.slice(0, 6).join(', ')}${got.length > 6 ? ', …' : ''}] (${got.length})`);
  const source = (check.expectItems || []).map((x) => identity(x, match));
  const shared = source.filter((x) => got.includes(x));
  const inGot = got.filter((x) => shared.includes(x));
  if (shared.join('|') !== inGot.join('|')) reasons.push(`order differs from the source on the shared items: source [${shared.join(', ')}] · here [${inGot.join(', ')}]`);
  const coverage = source.length ? ` · source items delivered ${shared.length}/${source.length}${shared.length < source.length ? ' (partial migration: the rest are not in the source rows yet)' : ''}` : '';
  const summary = `${got.length} rendered from ${rows.length} source rows (rule → ${expected.length})${coverage}`;
  return { pass: reasons.length === 0, detail: reasons.length ? `${summary} · ${reasons.join(' · ')}` : `${summary} · runtime-sourced, rule holds`, reasons, expected, rendered: got };
}

/** Index-backed / data-fed features of class L or R that carry no runtime-list check. */
export const missingListChecks = (features = []) => features.filter((f) => LIST_DISPOSITIONS.has(f.disposition) && LIST_CLASSES.has(f.class)
  && !['decided-out', 'skipped-source-broken', 'scaffolded-awaiting-owner'].includes(f.status) && !(f.checks || []).some((c) => c.type === 'runtime-list'));

const RUNNERS = {
  async 'fetch-json'(c, { ctx, origin }) {
    const { page } = await openPage(ctx, origin, '/');
    const r = await page.evaluate(async (u) => { const res = await fetch(u); const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } const rows = j ? (Array.isArray(j) ? j.length : Array.isArray(j.data) ? j.data.length : (j.total ?? Object.keys(j).length)) : -1; return { status: res.status, rows, keys: j && !Array.isArray(j) ? Object.keys(j).slice(0, 10) : [] }; }, c.url.startsWith('http') ? c.url : origin + c.url);
    await page.close();
    const okRows = c.minRows === undefined || r.rows >= c.minRows; const okKeys = !c.expectKeys || c.expectKeys.every((k) => r.keys.includes(k));
    return { pass: r.status < 400 && r.rows >= 0 && okRows && okKeys, detail: `${r.status} · ${r.rows} rows${r.keys.length ? ` · keys ${r.keys.join(',')}` : ''}` };
  },
  async 'dom-count'(c, { ctx, origin }) {
    const { page, thirdParty } = await openPage(ctx, origin, c.path);
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, c.selector);
    await page.close();
    return { pass: n >= c.min, detail: `${n} × ${c.selector} (min ${c.min})`, thirdParty };
  },
  async 'click-dialog'(c, { ctx, origin }) {
    const { page, thirdParty } = await openPage(ctx, origin, c.path);
    await page.click(c.trigger, { timeout: 8000 });
    await settle(1500);
    const d = await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { width: Math.round(r.width), heading: (el.querySelector('h1,h2,h3,[class*="heading" i],[class*="title" i]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), fields: el.querySelectorAll('input,select,textarea').length, iframe: !!el.querySelector('iframe') }; }, DIALOG);
    let closed = null;
    if (d) { await page.keyboard.press('Escape'); await settle(500); closed = await page.evaluate((sel) => !document.querySelector(sel), DIALOG); }
    await page.close();
    const okH = !c.headingIncludes || (d && d.heading.toLowerCase().includes(c.headingIncludes.toLowerCase())); const okW = !c.minWidth || (d && d.width >= c.minWidth);
    return { pass: !!d && okH && okW && closed !== false, detail: d ? `dialog ${d.width}px · heading "${d.heading}" · ${d.fields} fields${d.iframe ? ' · iframe' : ''} · Escape closes: ${closed}` : 'no dialog opened', thirdParty };
  },
  async 'search-query'(c, { ctx, origin }) {
    const sep = c.path.includes('?') ? '&' : '?';
    const { page, thirdParty } = await openPage(ctx, origin, `${c.path}${sep}${c.param || 'q'}=${encodeURIComponent(c.term)}`);
    await page.waitForSelector(c.resultSelector, { timeout: 15000 }).catch(() => {});
    const results = await page.evaluate(({ s, ts }) => [...document.querySelectorAll(s)].map((el) => {
      const squash = (x) => String(x || '').replace(/\s+/g, ' ').trim();
      const t = ts ? el.querySelector(ts) : (el.matches('a, h1, h2, h3, h4') ? el : el.querySelector('h1, h2, h3, h4, [class*="title" i], a'));
      return { title: squash((t || el).textContent), text: squash(el.textContent), href: el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || '' };
    }), { s: c.resultSelector, ts: c.titleSelector || null });
    await page.close();
    const { pass, detail } = compareSearchResults(results, c);
    return { pass, detail, thirdParty };
  },
  async 'runtime-list'(c, { ctx, origin, authHeader }) {
    const headers = authHeader ? { authorization: authHeader } : {};
    const withLimit = (u) => (/[?&]limit=/.test(u) ? u : `${u}${u.includes('?') ? '&' : '?'}limit=5000`);
    const src = c.source.startsWith('http') ? c.source : origin + c.source;
    const get = (u) => ctx.request.get(u, { headers: src.startsWith(origin) ? headers : {} });
    let res = await get(withLimit(src));
    if (res.status() === 400) res = await get(src); // a code-bus JSON refuses the sheet paging parameter
    const rows = sourceRows(await res.json().catch(() => null), c.sheet || null);
    const plainUrl = `${origin}${c.path === '/' ? '/index' : c.path.replace(/\/$/, '')}.plain.html`;
    const plain = await (await ctx.request.get(plainUrl, { headers })).text().catch(() => '');
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(origin + c.path, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    const sel = `.${String(c.block).split(/\s+/).filter(Boolean).join('.')}`;
    const items = c.itemSelector || 'a[href]';
    await page.evaluate(({ s, n }) => document.querySelectorAll(s)[n]?.scrollIntoView({ block: 'center' }), { s: sel, n: c.nth || 0 });
    await page.waitForFunction(({ s, n, i }) => document.querySelectorAll(s)[n]?.querySelector(i), { s: sel, n: c.nth || 0, i: items }, { timeout: 15000 }).catch(() => {});
    await settle(1500);
    const rendered = await page.evaluate(({ s, n, i, text }) => {
      const b = document.querySelectorAll(s)[n];
      if (!b) return [];
      const seen = []; // one entry per item: its own href or the first link inside it
      b.querySelectorAll(i).forEach((el) => {
        const v = text ? el.textContent : (el.getAttribute('href') || el.querySelector('a[href]')?.getAttribute('href') || '');
        if (v && !seen.includes(v)) seen.push(v);
      });
      return seen;
    }, { s: sel, n: c.nth || 0, i: items, text: c.match === 'text' });
    await page.close();
    const requested = requests.some((u) => listPath(u) === listPath(src));
    const authored = authoredItems(plain, c, rows);
    const v = judgeRuntimeList({ authored, requested, rendered, rows }, c);
    return { pass: v.pass, detail: v.detail };
  },
  async 'form-flow'(c, { ctx, origin }) {
    const { page, thirdParty } = await openPage(ctx, origin, c.path);
    const scope = c.form || 'form';
    const posts = []; page.on('request', (r) => { if (['POST', 'PUT'].includes(r.method()) && ['xhr', 'fetch', 'document'].includes(r.resourceType())) posts.push(r.url()); });
    await page.click(`${scope} ${c.submit}`, { timeout: 8000 });
    await settle(600);
    const emptyStatus = await page.evaluate((s) => (document.querySelector(s)?.textContent || '').trim().slice(0, 80), c.statusSelector || `${scope} [class*="status" i], ${scope} [class*="error" i], ${scope} [aria-live]`);
    const emptyPosted = posts.length;
    const invalid = await page.evaluate((s) => !!document.querySelector(`${s} :invalid`), scope);
    const emptyRefused = emptyPosted === 0 && (invalid || emptyStatus.length > 0);
    for (const [name, value] of Object.entries(c.fill || {})) {
      const sel = `${scope} [name="${name}"]`;
      const kind = await page.evaluate((s) => { const el = document.querySelector(s); return el ? `${el.tagName.toLowerCase()}:${el.type || ''}` : ''; }, sel);
      if (kind.startsWith('select')) await page.selectOption(sel, String(value)).catch(() => {}); else if (/:(checkbox|radio)$/.test(kind)) await page.check(sel).catch(() => {}); else await page.fill(sel, String(value)).catch(() => {});
    }
    await page.click(`${scope} ${c.submit}`, { timeout: 8000 });
    await settle(2000);
    const arrived = c.endpointPattern ? posts.some((u) => new RegExp(c.endpointPattern).test(u)) : posts.length > emptyPosted;
    const success = c.successIncludes ? (await page.evaluate(() => document.body.innerText)).toLowerCase().includes(c.successIncludes.toLowerCase()) : true;
    await page.close();
    return { pass: emptyRefused && arrived && success, detail: `empty refused: ${emptyRefused}${emptyStatus ? ` ("${emptyStatus}")` : ''} · filled posted: ${arrived}${posts.length ? ` (${posts.slice(-1)[0].slice(0, 80)})` : ''} · success copy: ${success}`, thirdParty };
  },
  async 'video-plays'(c, { ctx, origin }) {
    const { page, thirdParty } = await openPage(ctx, origin, c.path);
    if (c.trigger) { await page.click(c.trigger, { timeout: 8000 }); await settle(4000); } else await settle(3000);
    const iframe = await page.evaluate((s) => !!document.querySelector(s), c.iframeSelector || 'iframe[src*="player" i], dialog iframe, [role=dialog] iframe');
    const videoSel = c.videoSelector || 'video';
    const video = await sampleVideo(page, videoSel);
    let reduced = null;
    if (video && c.reducedMotionPauses) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (c.trigger) { await page.click(c.trigger, { timeout: 8000 }); }
      await settle(2000);
      reduced = await sampleVideo(page, videoSel);
    }
    await page.close();
    const playback = c.playbackHost ? thirdParty.filter((t) => new RegExp(c.playbackHost, 'i').test(t.host)) : [];
    const ok = playback.some((t) => t.status < 400); const failed = playback.filter((t) => t.status >= 400);
    const v = judgeVideoPlayback({ iframe, video, reduced, vendorOk: ok, vendorRequests: playback.length }, c);
    return { pass: v.pass, detail: `${v.detail}${failed.length ? ` · ${failed.length} ≥400 — check whether the probe leaked auth to the vendor` : ''}`, thirdParty };
  },
  async 'consent-gate'(c, { ctx, origin }) {
    const { page, thirdParty } = await openPage(ctx, origin, c.path);
    await settle(4000);
    await page.close();
    const leaked = thirdParty.filter((t) => c.forbiddenHosts.some((h) => t.host.includes(h)));
    return { pass: leaked.length === 0, detail: leaked.length ? `fired before consent: ${[...new Set(leaked.map((t) => t.host))].join(', ')}` : `no request to ${c.forbiddenHosts.length} gated host pattern(s) before consent`, thirdParty };
  },
  async martech(c, { ctx, origin }) {
    const own = new URL(origin).host;
    if ((c.productionHosts || []).includes(own)) return { pass: true, detail: `skipped — ${own} is a production host; replay on the preview origin` };
    const page = await ctx.newPage();
    const hosts = new Set();
    try {
      await page.route('**/*', (route) => {
        const h = hostOf(route.request().url());
        if (!h || sameSite(h, own)) return route.fallback();
        hosts.add(h);
        return route.abort();
      });
      await page.goto(origin + c.path, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await settle(c.waitMs || 6000);
    } finally {
      await page.close();
    }
    return judgeMartechRequests([...hosts], c);
  },
  async 'no-page-errors'(c, { ctx, origin }) {
    const all = [];
    for (const p of c.paths) { const { page, errors } = await openPage(ctx, origin, p); await page.close(); all.push(...errors.map((e) => `${p}: ${e}`)); }
    return { pass: all.length === 0, detail: all.length ? all.slice(0, 3).join(' | ').slice(0, 200) : `none on ${c.paths.length} page(s)` };
  },
};

const featuresOf = (parity, contract) => [...(parity?.features || []), ...(contract ? [martechChecks(contract)] : [])];

/** replay every check of every feature; returns results with per-check third-party statuses */
export async function replay({ origin, parity, contract = null, authHeader = null, headed = false }) {
  const features = featuresOf(parity, contract);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await attachOriginAuth(ctx, origin, authHeader);
  const results = missingListChecks(features).map((f) => ({ feature: f.feature, id: f.id, class: f.class, status: f.status, type: 'runtime-list', pass: false, detail: `no runtime-list check — a ${f.disposition} list proves it renders from its source (dynamics triage rule 10)`, thirdParty: '', ms: 0, environmentLimit: null }));
  results.forEach((r) => console.error(`[dynamics-check] FAIL ${r.feature} · runtime-list — ${r.detail}`));
  for (const f of features) {
    for (const c of f.checks || []) {
      const t0 = Date.now();
      const runner = RUNNERS[c.type];
      let r;
      if (!runner) r = { pass: false, detail: `unknown check type "${c.type}"` };
      else { try { r = await runner(c, { ctx, origin, authHeader }); } catch (e) { r = { pass: false, detail: `error: ${String(e.message).slice(0, 140)}` }; } }
      results.push({ feature: f.feature, id: f.id, class: f.class, status: f.status, type: c.type, pass: !!r.pass, detail: r.detail, thirdParty: summarize(r.thirdParty || []), ms: Date.now() - t0, environmentLimit: f.environmentLimit || null });
      console.error(`[dynamics-check] ${r.pass ? 'PASS' : 'FAIL'} ${f.feature} · ${c.type} — ${r.detail}`);
    }
  }
  await browser.close().catch(() => {});
  return results;
}

/* ---------------------------------------------------------------- cli ---- */
if (process.argv[1] && process.argv[1].endsWith('dynamics-check.mjs')) {
  // --help prints this file's usage header, so an agent never reads the source to learn the flags.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const header = src.match(/\/\*\*[\s\S]*?\*\//);
    console.log(header ? header[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim() : 'no usage header');
    process.exit(0);
  }
  const origin = (arg('origin') || '').replace(/\/$/, '');
  if (!origin) { console.error('usage: dynamics-check.mjs --origin <published origin> [--parity stardust/dynamics/parity.json]'); process.exit(2); }
  const parityFile = arg('parity', 'stardust/dynamics/parity.json');
  const contractFile = arg('contract') || (existsSync(DEFAULT_CONTRACT) ? DEFAULT_CONTRACT : null);
  const contract = contractFile ? readJSON(contractFile) : null;
  const parity = readJSON(parityFile, contract ? { features: [] } : undefined);
  const results = await replay({ origin, parity, contract, authHeader: resolveAuthHeader(), headed: flag('headed') });
  const out = arg('out', 'stardust/qa');
  const pass = results.filter((r) => r.pass).length;
  const features = featuresOf(parity, contract);
  const md = [
    `# Dynamics parity check — ${origin} — ${new Date().toISOString()}`, '',
    `Replayed ${results.length} checks over ${features.length} features · pass ${pass} · fail ${results.length - pass}. Flows, not presence.`, '',
    '| feature | class | status | check | result | detail | third-party requests |', '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.feature} | ${r.class} | ${r.status || ''} | ${r.type} | ${r.pass ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '/')} | ${r.thirdParty} |`),
    '', '## Features without checks', '',
    ...features.filter((f) => !(f.checks || []).length).map((f) => `- ${f.feature} (${f.class}) — ${f.status}${f.owner ? ` · owner: ${f.owner}` : ''}${f.environmentLimit ? ` · environment limit: ${f.environmentLimit}` : ''}`),
  ];
  writeText(join(out, 'dynamics-report.md'), md.join('\n'));
  writeJSON(join(out, 'dynamics-report.json'), { _provenance: provenance('check', { origin, parity: parityFile, ...(contractFile && { contract: contractFile }) }), results });
  console.error(`[dynamics-check] ${pass}/${results.length} pass → ${join(out, 'dynamics-report.md')}`);
  process.exitCode = pass === results.length ? 0 : 1; // an unref'd exit timer let a failing run end 0
  setTimeout(() => process.exit(process.exitCode), 200).unref();
}
