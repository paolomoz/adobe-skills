#!/usr/bin/env node
/**
 * skills/deploy/scripts/localize-links.mjs — link localization as a pipeline stage.
 *
 * Why this exists: generators faithfully carry captured hrefs as fully-qualified
 * source-domain URLs (the D4 "author URLs as opaque tokens" rule), and that
 * silently shipped hundreds of links across a whole migration that bounced
 * visitors OFF the new origin back to the live site — for targets that existed
 * on the new origin all along. D4 is a capture-fidelity rule; it must never be
 * read as a delivery rule. Internal links must be root-relative so the site
 * works on any origin; a link stays absolute ONLY when its target is genuinely
 * external or not (yet) in the migration set — that is the honest integration
 * boundary, and this tool reports it.
 *
 * What it does (idempotent, over the WHOLE tree — before every write and at every
 * wave close, rollout Phase C § Wave close, #145):
 *   1. Builds the URL map from the content tree: every *.html under --content
 *      is a page served at its URL (eds-path.mjs: extensionless; a folder index
 *      `x/index.html` at `/x/`, a leaf at `/x/y`; root `/`), plus the entries of
 *      --redirects (source path → destination) when given.
 *   2. Rewrites every <a href> whose host is a --source-host (with or without
 *      `www.`, http or https or protocol-relative) AND whose path resolves in
 *      the map to that root-relative URL (EDS 404s on `.html` and on a leaf's
 *      trailing slash; `/x` 404s for a folder index), preserving ?query
 *      and #fragment.
 *   3. Normalizes root-relative internal hrefs that resolve in the map to the
 *      same URL.
 *   4. Leaves everything else untouched: other hosts, mailto:/tel:, anchors,
 *      and source-host links whose path is NOT in the map (reported).
 *
 * Usage:
 *   node skills/deploy/scripts/localize-links.mjs --source-host <host[,host]> \
 *        [--content content] [--redirects stardust/redirects.tsv|.json|.jsonl] \
 *        [--ledger stardust/rollout/repointed.json [--roster <pages.json>] [--reason <word>]] \
 *        [--changed <paths-file>] [--dry-run] [--check] [--json]
 *
 *   --source-host  the live site's host(s); `www.` is matched either way
 *   --content      root of the authored content tree (default: content)
 *   --redirects    TSV `source<TAB>destination` (rollout's stardust/redirects.tsv), JSON
 *                  ([{source,destination}], {source: destination}, the DA sheet {data:[…]}),
 *                  or JSON Lines ({src,target}: spec's knowledge/redirects.jsonl)
 *   --ledger       the repoint ledger (#145): every source-host link left absolute, rewritten
 *                  each write run as { hosts, at, counts: {links, targets, byReason},
 *                  links: [{page, href, target, reason}] }. reason: `pending-wave` when the
 *                  target is a roster page (a later wave delivers it), else the reason the
 *                  ledger already holds for that target (an E2 decision: scope-extension,
 *                  capture-gap, source-404, app-route, other-locale…), else --reason, else
 *                  `unclassified`. A target that has since shipped leaves the ledger (relocalized).
 *   --roster       coverage pages.json (default: coverage/pages.json beside the ledger, when present)
 *   --reason       the reason recorded for targets new to the ledger
 *   --changed      write the web paths of the documents this run rewrote, one per line
 *                  (`deploy-batch.mjs --paths <file> --force` re-PUTs exactly those)
 *   --dry-run      report what would change, write nothing
 *   --check        gate mode: write nothing, exit 2 if ANY link would change
 *                  (run the plain pass first; --check is the pre-deploy assertion)
 *   --json         machine-readable summary
 *
 * Writes: the rewritten *.html files IN PLACE under --content, the --ledger and --changed files
 * (nothing with --dry-run or --check; the summary is stdout).
 *
 * Exit codes: 0 clean (or rewritten), 2 --check found localizable links,
 * 1 usage/IO error. Dependency-free (regex over the authored HTML, the same
 * technique as davids-model-lint.mjs — content pages are machine-generated).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { deliveredUrl, pathKey as canonicalPath } from './eds-path.mjs';

function parseArgs(argv) {
  const rest = argv.slice(2);
  const opts = { content: 'content', hosts: [], redirects: null, ledger: null, roster: null, reason: null, changed: null, dryRun: false, check: false, json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--content') opts.content = rest[i += 1];
    else if (a === '--source-host') opts.hosts.push(...(rest[i += 1] || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--redirects') opts.redirects = rest[i += 1];
    else if (a === '--ledger') opts.ledger = rest[i += 1];
    else if (a === '--roster') opts.roster = rest[i += 1];
    else if (a === '--reason') opts.reason = rest[i += 1];
    else if (a === '--changed') opts.changed = rest[i += 1];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--check') { opts.check = true; opts.dryRun = true; }
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown argument ${a}`); usage(); process.exit(1); }
  }
  if (!opts.hosts.length) { console.error('--source-host is required'); usage(); process.exit(1); }
  if (!existsSync(opts.content) || !statSync(opts.content).isDirectory()) { console.error(`--content ${opts.content} is not a directory`); process.exit(1); }
  return opts;
}

function usage() {
  console.error('usage: localize-links.mjs --source-host <host[,host]> [--content content] [--redirects file] [--ledger file [--roster pages.json] [--reason word]] [--changed file] [--dry-run] [--check] [--json]');
}

// ----------------------------------------------------------------- URL map

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');

// Canonical lookup key for a path: eds-path.mjs pathKey (no query/fragment, .html, /index or trailing slash; lower case).
export { canonicalPath };

function collectHtml(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) collectHtml(p, out);
    else if (/\.html$/i.test(entry)) out.push(p);
  }
  return out;
}

/**
 * [source, destination] pairs from a redirects file. Pure. Reads rollout's TSV (`source<TAB>destination`, `#`
 * comments), JSON (`[{source,destination}]`, `{source: destination}`, or the published DA sheet
 * `{data:[{Source,Destination}]}`), and JSON Lines (`{src,target}` rows as in spec knowledge/redirects.jsonl, or
 * `{source,destination}`). Rows without both sides are skipped.
 */
export function redirectPairs(raw, file = '') {
  const pairs = [];
  const add = (r) => { if (!r || typeof r !== 'object') return; const s = r.source ?? r.Source ?? r.src; const d = r.destination ?? r.Destination ?? r.target; if (typeof s === 'string' && typeof d === 'string' && s && d) pairs.push([s, d]); };
  if (/\.jsonl$/i.test(file)) raw.split(/\r?\n/).forEach((l) => { if (l.trim()) add(JSON.parse(l)); });
  else if (/\.json$/i.test(file)) {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) j.forEach(add);
    else if (Array.isArray(j?.data)) j.data.forEach(add);
    else Object.entries(j).forEach(([s, d]) => { if (typeof d === 'string') pairs.push([s, d]); });
  } else {
    raw.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const [s, d] = t.split(/\t+|\s{2,}/);
      if (s && d) pairs.push([s, d]);
    });
  }
  return pairs;
}

function buildMap(files, root, redirectsFile) {
  const map = new Map(); // lookup key → the URL EDS serves (a folder index at /a/, a leaf at /a/b: eds-path.mjs)
  for (const f of files) {
    const rel = `/${path.relative(root, f).split(path.sep).join('/')}`;
    map.set(canonicalPath(rel), deliveredUrl(rel));
  }
  let redirects = 0; let pending = 0;
  if (redirectsFile) {
    const pairs = redirectPairs(readFileSync(redirectsFile, 'utf8'), redirectsFile);
    if (!pairs.length) console.error(`localize-links: no redirect pairs read from ${redirectsFile}`);
    // a redirect rewrites links only to a page of this content tree: one whose page ships in a later wave stays
    // absolute until then (a seeded spec covers every page of the site, a wave delivers a few)
    for (const [s, d] of pairs) {
      const src = canonicalPath(s.replace(/^https?:\/\/[^/]+/i, ''));
      const dst = map.get(canonicalPath(d.replace(/^https?:\/\/[^/]+/i, '')));
      if (dst === undefined) { pending += 1; continue; }
      if (!map.has(src)) { map.set(src, dst); redirects += 1; }
    }
  }
  return { map, redirects, pending };
}

// ------------------------------------------------------------------ rewrite

function parseHref(href) {
  const m = href.match(/^(?:(https?:)?\/\/([^/?#]+))?([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!m) return null;
  return { host: m[2] ? bareHost(m[2]) : null, path: m[3] || '', query: m[4] || '', hash: m[5] || '' };
}

export function localizeHref(href, { map, hosts }) {
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(href) || !href) return { href, action: 'skip' };
  const u = parseHref(href);
  if (!u) return { href, action: 'skip' };
  const isSource = u.host && hosts.includes(u.host);
  const isRootRel = !u.host && href.startsWith('/') && !href.startsWith('//');
  if (!isSource && !isRootRel) return { href, action: 'skip' };
  const key = canonicalPath(u.path);
  const target = map.get(key);
  if (target === undefined) return { href, action: isSource ? 'kept-absolute' : 'skip', key };
  const next = `${target}${u.query}${u.hash}`;
  if (next === href) return { href, action: 'already' };
  return { href: next, action: isSource ? 'localized' : 'normalized', key };
}

const HREF_RE = /(<a\b[^>]*?\bhref=)(["'])([^"']*)\2/gi;

function processFile(file, ctx) {
  const src = readFileSync(file, 'utf8');
  const counts = { localized: 0, normalized: 0 };
  const kept = [];
  const out = src.replace(HREF_RE, (whole, pre, q, href) => {
    const r = localizeHref(href, ctx);
    if (r.action === 'localized' || r.action === 'normalized') { counts[r.action] += 1; return `${pre}${q}${r.href}${q}`; }
    if (r.action === 'kept-absolute') kept.push({ href, target: r.key });
    return whole;
  });
  return { out, changed: out !== src, counts, kept };
}

// ------------------------------------------------------------ repoint ledger (#145)

/** The document's web path (deploy-batch's `--paths` form): `content/a/b.html` → `/a/b`. */
const webPathOf = (file, root) => `/${path.relative(root, file).split(path.sep).join('/').replace(/\.html$/i, '')}`;

/** Lookup keys of the roster rows (coverage pages.json `pages[].path` or `/<slug>`). Pure. */
export function rosterKeys(pagesDoc) {
  return new Set(((pagesDoc && pagesDoc.pages) || []).map((p) => canonicalPath(p.path || `/${p.slug || ''}`)));
}

/**
 * The next ledger from the links kept absolute this run. Pure. `kept`: [{page, href, target}].
 * Reason per target: a roster page → `pending-wave`; else the reason the previous ledger holds for the
 * target; else `reason`; else `unclassified`. `relocalized`: previous targets no longer kept (shipped).
 */
export function nextLedger(prev, kept, { roster = new Set(), reason = null, hosts = [], at = new Date().toISOString() } = {}) {
  const held = new Map(((prev && prev.links) || []).map((l) => [l.target, l.reason]));
  const why = (t) => (roster.has(t) ? 'pending-wave' : (held.get(t) && held.get(t) !== 'pending-wave' ? held.get(t) : reason || 'unclassified'));
  const links = kept.map((l) => ({ page: l.page, href: l.href, target: l.target, reason: why(l.target) }))
    .sort((x, y) => x.target.localeCompare(y.target) || x.page.localeCompare(y.page));
  const targets = new Set(links.map((l) => l.target));
  const byReason = {};
  links.forEach((l) => { byReason[l.reason] = (byReason[l.reason] || 0) + 1; });
  const relocalized = [...new Set(held.keys())].filter((t) => !targets.has(t)).sort();
  return { ledger: { hosts, at, counts: { links: links.length, targets: targets.size, byReason }, links }, relocalized };
}

// --------------------------------------------------------------------- tree

/**
 * One pass over the content tree, nothing written: per document the rewritten HTML, its counts and the
 * links kept absolute. done-check reads the same pass (its links_localizable gap = `--check` exit 2).
 */
export function localizeTree({ content, hosts, redirects = null }) {
  const bare = hosts.map(bareHost);
  const files = collectHtml(content).sort();
  const { map, redirects: nRedirects, pending } = buildMap(files, content, redirects);
  const docs = files.map((f) => ({ file: f, page: webPathOf(f, content), ...processFile(f, { map, hosts: bare }) }));
  const changed = docs.filter((d) => d.changed);
  const sum = (k) => changed.reduce((n, d) => n + d.counts[k], 0);
  const kept = docs.flatMap((d) => d.kept.map((k) => ({ page: d.page, ...k })));
  return { hosts: bare, pages: files.length, mapEntries: map.size, redirects: nRedirects, pending, docs, changed, localized: sum('localized'), normalized: sum('normalized'), kept };
}

// --------------------------------------------------------------------- main

function main() {
  // --help prints this file's usage header, so an agent never reads the source to learn the flags.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const header = src.match(/\/\*\*[\s\S]*?\*\//);
    console.log(header ? header[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim() : 'no usage header');
    process.exit(0);
  }
  const opts = parseArgs(process.argv);
  const t = localizeTree({ content: opts.content, hosts: opts.hosts, redirects: opts.redirects });
  const perFile = Object.fromEntries(t.changed.map((d) => [`${d.page}.html`, d.counts]));
  if (!opts.dryRun) t.changed.forEach((d) => writeFileSync(d.file, d.out));
  if (!opts.dryRun && opts.changed) {
    mkdirSync(path.dirname(opts.changed), { recursive: true });
    writeFileSync(opts.changed, t.changed.map((d) => `${d.page}\n`).join(''));
  }
  let ledgerNote = null;
  if (opts.ledger) {
    const rosterFile = opts.roster || path.join(path.dirname(opts.ledger), 'coverage', 'pages.json');
    const roster = existsSync(rosterFile) ? rosterKeys(JSON.parse(readFileSync(rosterFile, 'utf8'))) : new Set();
    const prev = existsSync(opts.ledger) ? JSON.parse(readFileSync(opts.ledger, 'utf8')) : null;
    const { ledger, relocalized } = nextLedger(prev, t.kept, { roster, reason: opts.reason, hosts: t.hosts });
    if (!opts.dryRun) { mkdirSync(path.dirname(opts.ledger), { recursive: true }); writeFileSync(opts.ledger, `${JSON.stringify(ledger, null, 2)}\n`); }
    ledgerNote = { file: opts.ledger, ...ledger.counts, relocalized: relocalized.length };
  }
  const keptAll = new Map();
  t.kept.forEach((k) => keptAll.set(k.target, (keptAll.get(k.target) || 0) + 1));
  const keptSorted = [...keptAll.entries()].sort((a, b) => b[1] - a[1]);
  const todo = t.localized + t.normalized;
  const summary = { content: opts.content, hosts: t.hosts, pages: t.pages, mapEntries: t.mapEntries, redirects: t.redirects, filesChanged: t.changed.length, localized: t.localized, normalized: t.normalized, keptAbsolute: keptSorted.length, keptLinks: t.kept.length, ledger: ledgerNote, mode: opts.check ? 'check' : opts.dryRun ? 'dry-run' : 'write' };

  if (opts.json) {
    console.log(JSON.stringify({ ...summary, perFile, kept: keptSorted.map(([p, n]) => ({ path: p, links: n })) }, null, 2));
  } else {
    const verb = opts.dryRun ? 'would localize' : 'localized';
    console.log(`localize-links: ${t.pages} pages, ${t.mapEntries} map entries (${t.redirects} from redirects${t.pending ? `; ${t.pending} redirect(s) to pages not in this tree kept for a later wave` : ''}), hosts ${t.hosts.join(', ')}`);
    console.log(`${verb} ${t.localized} source-host link(s) + normalized ${t.normalized} internal href(s) across ${t.changed.length} file(s)${opts.dryRun ? ' [no writes]' : ''}`);
    for (const [p, c] of Object.entries(perFile)) console.log(`  ${p}: ${c.localized} localized, ${c.normalized} normalized`);
    if (keptSorted.length) {
      console.log(`\nabsolute source-host links KEPT: ${t.kept.length} link(s) to ${keptSorted.length} target(s) not in the migration set (the honest boundary; the wave close re-runs this):`);
      keptSorted.slice(0, 20).forEach(([p, n]) => console.log(`  ${String(n).padStart(4)}  ${p}`));
      if (keptSorted.length > 20) console.log(`  … ${keptSorted.length - 20} more target(s)`);
    }
    if (ledgerNote) console.log(`\nledger ${ledgerNote.file}${opts.dryRun ? ' [not written]' : ''}: ${ledgerNote.links} link(s), ${ledgerNote.targets} target(s) — ${Object.entries(ledgerNote.byReason).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}; relocalized ${ledgerNote.relocalized} target(s)`);
    if (opts.changed && !opts.dryRun) console.log(`changed documents → ${opts.changed} (${t.changed.length}): deploy-batch.mjs --paths ${opts.changed} --force`);
    if (opts.check) console.log(`\nCHECK ${todo ? 'FAIL' : 'PASS'} — ${todo} link(s) still localizable`);
  }
  process.exit(opts.check && todo ? 2 : 0);
}

if (process.argv[1] && /localize-links\.mjs$/.test(process.argv[1])) main();
