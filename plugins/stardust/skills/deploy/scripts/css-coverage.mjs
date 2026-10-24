#!/usr/bin/env node
/**
 * deploy/css-coverage.mjs — block CSS weight, measured and pruned against the delivered pages (#142b).
 * A lifted cascade ships whole into `blocks/<b>/<b>.css`; this finds the rules no delivered page can
 * match and the declarations a later identical copy makes redundant, and removes them.
 *
 *   snapshot  load every page × width from the origin (consent clicked, page scrolled, every block
 *             `loaded`), store the decorated DOM (scripts stripped) and the block files it loaded:
 *             <out>/snap/<slug>@<width>.html.gz + <out>/loads.json. The slow, networked pass; a page
 *             or block file answering ≥ 400 (a 429 burst) is retried with backoff, never stored.
 *   match     offline: every selector of every `<blocks>/**.css`, relaxed (below), is tested with
 *             querySelector against each snapshot (Chromium, JS off, network off). Writes
 *             <out>/coverage.json (per file: rules, per-selector hits on pages that load the file) and
 *             prints per page the block code loaded vs the CSS that matches there (gz KB), median/p90,
 *             and the look carry: per block look (the first class after the name), the CSS only that
 *             look's pages match and how many pages load it without showing the look.
 *   prune     rewrites the CSS files of coverage.json (refused for a file changed since `match`):
 *             a selector that matched on no page is dropped, a rule left with none is removed, an
 *             empty conditional group is removed; an exact duplicate declaration inside a rule is
 *             dropped (the later copy stays); an earlier rule whose selector, conditions and every
 *             declaration recur in a later rule is removed. Dry run unless --write; the removed
 *             selectors are listed in <out>/pruned.json.
 * Relaxed selector (a rule must stay when any interaction could make it match): pseudo-elements,
 * state pseudo-classes (:hover, :focus*, :checked, :open, …), every `:not(…)` and every attribute
 * selector are dropped; so is a class the JS toggles (classList.add/remove/toggle/replace args,
 * className assignments, a template-literal prefix) or one named in a JS string but absent from every
 * snapshot (built on interaction); a compound naming a class assigned next to a free `${…}` loses all
 * its classes; an element an author can add in a cell (a, p, li, img, strong, h1–h6, table, …) is
 * any element; an emptied compound becomes `*`. A selector Chromium cannot parse
 * counts as matched. Media/supports conditions are not evaluated — widths other than the snapshots'
 * keep their rules. @font-face/@keyframes/@property and statements are kept.
 *
 * Usage:
 *   node css-coverage.mjs snapshot --origin <url> --pages <file|/a,/b> [--widths 1440,360] --out <dir>
 *        [--consent <selector>] [--dismiss <sel,sel>] [--block-hosts <regex>] [--concurrency 3]
 *        [--only /a,/b] [--skip-existing]
 *   node css-coverage.mjs match --out <dir> [--blocks blocks] [--js blocks,scripts,widgets]
 *   node css-coverage.mjs prune --out <dir> [--write]
 * Exit 0 after a run; 1 usage, no snapshots, or a stale coverage file on prune.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain && (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length < 3)) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  console.log(src.match(/\/\*\*[\s\S]*?\*\//)[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim());
  process.exit(process.argv.length < 3 ? 1 : 0);
}

// ---------- CSS scanning (span-preserving: prune edits the source text, never re-serialises) ----------
const skipString = (t, i, to) => { const q = t[i]; let j = i + 1; while (j < to && t[j] !== q) j += t[j] === '\\' ? 2 : 1; return j + 1; };
const skipComment = (t, i, to) => { const e = t.indexOf('*/', i + 2); return e < 0 || e >= to ? to : e + 2; };
function skipWs(t, i, to) {
  let j = i;
  for (;;) {
    while (j < to && /\s/.test(t[j])) j += 1;
    if (t[j] === '/' && t[j + 1] === '*') j = skipComment(t, j, to); else return j;
  }
}
function matchBrace(t, open, to) {
  let depth = 0; let j = open;
  while (j < to) {
    const c = t[j];
    if (c === '/' && t[j + 1] === '*') { j = skipComment(t, j, to); continue; }
    if (c === '"' || c === "'") { j = skipString(t, j, to); continue; }
    if (c === '\\') { j += 2; continue; }
    if (c === '{') depth += 1; else if (c === '}') { depth -= 1; if (!depth) return j; }
    j += 1;
  }
  return to;
}
export const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const GROUP = /^@(media|supports|container|layer|scope|document|starting-style)\b/i;

/** Nodes of a stylesheet: rule {head, start, end, bodyStart, bodyEnd}, at (children when a conditional group), stmt. */
export function scanCss(t, from = 0, to = t.length) {
  const nodes = [];
  let i = from;
  while (i < to) {
    i = skipWs(t, i, to);
    if (i >= to) break;
    const start = i; let j = i; let paren = 0;
    while (j < to) {
      const c = t[j];
      if (c === '/' && t[j + 1] === '*') { j = skipComment(t, j, to); continue; }
      if (c === '"' || c === "'") { j = skipString(t, j, to); continue; }
      if (c === '\\') { j += 2; continue; }
      if (c === '(' || c === '[') paren += 1; else if (c === ')' || c === ']') paren -= 1;
      else if (paren <= 0 && (c === '{' || c === ';' || c === '}')) break;
      j += 1;
    }
    if (j >= to || t[j] === '}') { i = j + 1; continue; }
    const head = stripComments(t.slice(start, j)).trim();
    if (t[j] === ';') { nodes.push({ type: 'stmt', head, start, end: j + 1 }); i = j + 1; continue; }
    const bodyEnd = matchBrace(t, j, to);
    const node = { type: head.startsWith('@') ? 'at' : 'rule', head, start, headEnd: j, bodyStart: j + 1, bodyEnd, end: bodyEnd + 1 };
    if (node.type === 'at' && GROUP.test(head)) node.children = scanCss(t, j + 1, bodyEnd);
    nodes.push(node);
    i = bodyEnd + 1;
  }
  return nodes;
}

/** Split at top-level `sep` (default ',') — parens, brackets, strings and escapes respected. */
export function splitTop(s, sep = ',') {
  const out = []; let depth = 0; let last = 0; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i, s.length); continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === '(' || c === '[') depth += 1; else if (c === ')' || c === ']') depth -= 1;
    else if (c === sep && !depth) { out.push(s.slice(last, i)); last = i + 1; }
    i += 1;
  }
  out.push(s.slice(last));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Declarations of a rule body: [{prop, value, important, start, end}] (offsets absolute); null when nested rules. */
export function parseDecls(t, from, to) {
  const decls = []; let i = from; let depth = 0; let segStart = from;
  const flush = (end) => {
    const raw = t.slice(segStart, end); const clean = stripComments(raw).trim();
    if (clean) {
      const k = clean.indexOf(':');
      if (k > 0) {
        const p = clean.slice(0, k).trim(); let v = clean.slice(k + 1).trim(); const important = /!\s*important\s*$/i.test(v);
        if (important) v = v.replace(/!\s*important\s*$/i, '').trim();
        decls.push({ prop: p.startsWith('--') ? p : p.toLowerCase(), value: v.replace(/\s+/g, ' '), important, start: segStart, end: Math.min(end + 1, to) });
      }
    }
    segStart = end + 1;
  };
  while (i < to) {
    const c = t[i];
    if (c === '/' && t[i + 1] === '*') { i = skipComment(t, i, to); continue; }
    if (c === '"' || c === "'") { i = skipString(t, i, to); continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === '{') return null;
    if (c === '(' || c === '[') depth += 1; else if (c === ')' || c === ']') depth -= 1;
    else if (c === ';' && !depth) flush(i);
    i += 1;
  }
  flush(to);
  return decls;
}

// ---------- selector relaxation ----------
const KEEP_FN = /^(is|where|has|matches|-webkit-any|-moz-any)$/i;
const KEEP_PSEUDO = /^(root|scope)$/i;
// elements an author adds in a cell (content can change; the structure decorate builds cannot)
const AUTHORED = new Set('a abbr b blockquote br code del em figcaption figure h1 h2 h3 h4 h5 h6 hr i iframe img li ol p picture pre s source span strong sub sup table tbody td th thead tr u ul video'.split(' '));
const readIdent = (s, i) => { let j = i; while (j < s.length && (/[\w-]/.test(s[j]) || s[j] === '\\' || s.charCodeAt(j) > 127)) j += s[j] === '\\' ? 2 : 1; return j; };
const unescape = (id) => id.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (m, c) => (/^[0-9a-fA-F]/.test(c) && c.length > 1 ? String.fromCodePoint(parseInt(c, 16)) : c));
function readParens(s, i) { // s[i] === '(' → index after the matching ')'
  let depth = 0; let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'") { j = skipString(s, j, s.length); continue; }
    if (c === '\\') { j += 2; continue; }
    if (c === '(') depth += 1; else if (c === ')') { depth -= 1; if (!depth) return j + 1; }
    j += 1;
  }
  return s.length;
}

/** Relax one complex selector (see the header); `isDyn(className)` → the class may be added at runtime. */
export function relaxSelector(sel, isDyn = () => false) {
  const s = sel.trim(); const parts = []; let cur = null; let comb = null; let ws = false; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { ws = true; i += 1; continue; }
    if (c === '>' || c === '+' || c === '~') { comb = c; ws = false; cur = null; i += 1; continue; }
    if (!cur || ws) {
      if (parts.length || comb) parts.push({ comb: comb || ' ' });
      cur = { items: [], cls: new Map(), all: [] }; parts.push(cur); comb = null; ws = false;
    }
    if (c === '.') { const j = readIdent(s, i + 1); const name = unescape(s.slice(i + 1, j)); cur.all.push(name); if (!isDyn(name)) { cur.cls.set(cur.items.length, name); cur.items.push(s.slice(i, j)); } i = j; continue; }
    if (c === '#') { const j = readIdent(s, i + 1); cur.items.push(s.slice(i, j)); i = j; continue; }
    if (c === '[') {
      let j = i; let d = 0;
      while (j < s.length) { if (s[j] === '"' || s[j] === "'") { j = skipString(s, j, s.length); continue; } if (s[j] === '[') d += 1; else if (s[j] === ']') { d -= 1; if (!d) break; } j += 1; }
      i = j + 1; continue;
    }
    if (c === ':') {
      const el = s[i + 1] === ':'; const j = readIdent(s, i + (el ? 2 : 1)); const name = s.slice(i + (el ? 2 : 1), j);
      let k = j; let args = null;
      if (s[j] === '(') { k = readParens(s, j); args = s.slice(j + 1, k - 1); }
      if (!el && args !== null && KEEP_FN.test(name)) cur.items.push(`:${name}(${splitTop(args).map((a) => relaxSelector(a, isDyn)).join(', ')})`);
      else if (!el && args === null && KEEP_PSEUDO.test(name)) cur.items.push(`:${name}`);
      i = k; continue;
    }
    const j = c === '*' || c === '&' || c === '|' ? i + 1 : Math.max(readIdent(s, i), i + 1);
    if (!AUTHORED.has(s.slice(i, j).toLowerCase())) cur.items.push(s.slice(i, j));
    i = j;
  }
  const anchors = isDyn.anchors || new Set();
  const render = (p) => {
    const anchored = p.all.some((n) => anchors.has(n)); // a class set from a free `${…}`: every class may vary
    return p.items.filter((it, k) => !(anchored && p.cls.has(k))).join('') || '*';
  };
  return parts.map((p) => (p.comb ? (p.comb === ' ' ? ' ' : ` ${p.comb} `) : render(p))).join('').trim();
}

/** Class tokens of a selector (escapes resolved; inside functional pseudos included). */
export const selectorClasses = (sel) => [...sel.matchAll(/\.((?:[\w-]|\\.|[^\x00-\x7f])+)/g)].map((m) => unescape(m[1]));

/** From JS source: classes toggled at runtime, template-literal prefixes, and every word in a string literal. */
export function jsClassTokens(js) {
  const toggled = new Set(); const prefixes = new Set(); const literal = new Set(); const anchors = new Set();
  const lits = (s) => [...s.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const words = (l) => l.replace(/\$\{[^}]*\}/g, ' ').split(/[^\w-]+/).filter((w) => /^-?[A-Za-z_][\w-]*$/.test(w));
  for (const l of lits(js)) for (const w of words(l)) literal.add(w);
  const ctx = [
    ...js.matchAll(/classList\.(?:add|remove|toggle|replace)\s*\(([^)]*)\)/g),
    ...js.matchAll(/\bclassName\s*\+?=\s*([^;\n]+)/g),
    ...js.matchAll(/setAttribute\(\s*['"]class['"]\s*,([^)]*)\)/g),
  ];
  for (const m of ctx) {
    for (const l of lits(m[1])) {
      for (const w of words(l)) toggled.add(w);
      for (const p of l.matchAll(/([\w-]+)\$\{/g)) prefixes.add(p[1]);
      // a free `${…}` class: any class may join the literal's static ones on that element
      if (/(^|\s)\$\{[^}]*\}(?=\s|$)/.test(l)) words(l).forEach((w) => anchors.add(w));
    }
  }
  return { toggled, prefixes, literal, anchors };
}

/** The dynamic-class predicate: toggled, a toggled prefix, or a JS literal absent from every snapshot. */
export function dynamicPredicate({ toggled, prefixes, literal, anchors = new Set() }, domClasses) {
  const pre = [...prefixes];
  const isDyn = (name) => toggled.has(name) || pre.some((p) => name.startsWith(p)) || (literal.has(name) && !domClasses.has(name));
  isDyn.anchors = anchors;
  return isDyn;
}

// ---------- prune (pure) ----------
const declKey = (d) => `${d.prop}:${d.value}:${d.important ? 1 : 0}`;

/** Rewrite a stylesheet: `keep(ruleIndex, selectorIndex)` says which selectors stay (rules in source order). */
export function pruneCss(t, keep) {
  const nodes = scanCss(t); const rules = [];
  const index = (list, ctx) => {
    for (const n of list) {
      if (n.type === 'rule') { n.idx = rules.length; n.ctx = ctx; rules.push(n); } else if (n.children) index(n.children, `${ctx}|${n.head.replace(/\s+/g, ' ')}`);
    }
  };
  index(nodes, '');
  const stats = { rules: rules.length, deadRules: 0, deadSelectors: 0, dupDecls: 0, overridden: 0, empty: 0, groups: 0 };
  const removed = [];
  for (const n of rules) {
    n.sels = splitTop(n.head); n.keep = n.sels.map((_, j) => keep(n.idx, j));
    n.dead = !n.keep.some(Boolean);
    const gone = n.sels.filter((_, j) => !n.keep[j]); stats.deadSelectors += gone.length; removed.push(...gone);
    if (n.dead) { stats.deadRules += 1; continue; }
    n.decls = parseDecls(t, n.bodyStart, n.bodyEnd); n.drop = [];
    if (!n.decls) continue;
    n.decls.forEach((d, i) => { if (n.decls.slice(i + 1).some((e) => declKey(e) === declKey(d))) n.drop.push(d); });
    stats.dupDecls += n.drop.length;
    n.set = new Set(n.decls.filter((d) => !n.drop.includes(d)).map(declKey));
    n.key = `${n.ctx}§${n.sels.filter((_, j) => n.keep[j]).map((x) => x.replace(/\s+/g, ' ')).join(',')}`;
  }
  const live = rules.filter((n) => !n.dead && n.decls);
  const later = new Map();
  for (let a = live.length - 1; a >= 0; a -= 1) {
    const n = live[a];
    if (!n.set.size) { n.dead = true; stats.empty += 1; continue; }
    const seen = later.get(n.key) || [];
    if (seen.some((m) => [...n.set].every((k) => m.set.has(k)))) { n.dead = true; stats.overridden += 1; continue; }
    seen.push(n); later.set(n.key, seen);
  }
  const edits = [];
  const emit = (list) => {
    let alive = 0;
    for (const n of list) {
      if (n.type === 'rule') {
        if (n.dead) { edits.push([n.start, n.end, '']); continue; }
        alive += 1;
        if (n.keep.some((x) => !x)) {
          const ind = t.slice(t.lastIndexOf('\n', n.start - 1) + 1, n.start);
          edits.push([n.start, n.headEnd, `${n.sels.filter((_, j) => n.keep[j]).join(`,\n${/^\s*$/.test(ind) ? ind : ''}`)} `]);
        }
        for (const d of n.drop || []) edits.push([d.start, d.end, '']);
      } else if (n.children) {
        const before = edits.length;
        if (emit(n.children)) alive += 1; else { edits.length = before; edits.push([n.start, n.end, '']); stats.groups += 1; }
      } else alive += 1;
    }
    return alive;
  };
  emit(nodes);
  edits.sort((x, y) => y[0] - x[0]);
  let out = t;
  for (const [s, e, r] of edits) out = out.slice(0, s) + r + out.slice(e);
  out = out.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
  return { text: out, stats, removed };
}

/** Rules of a stylesheet in prune's order: [{ sels, ctx }]. */
export function cssRules(t) {
  const rules = [];
  const walk = (list, ctx) => { for (const n of list) { if (n.type === 'rule') rules.push({ sels: splitTop(n.head), ctx, start: n.start, end: n.end }); else if (n.children) walk(n.children, `${ctx}|${n.head.replace(/\s+/g, ' ')}`); } };
  walk(scanCss(t), '');
  return rules;
}

export const quantile = (xs, q) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]; };
export const gz = (s) => gzipSync(Buffer.isBuffer(s) ? s : Buffer.from(s)).length;
export const slugOf = (p) => (p === '/' ? 'index' : p.replace(/^\/|\/$/g, '').replace(/\//g, '--'));

// ---------- CLI ----------
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const listFiles = (dir, ext) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? listFiles(p, ext) : (p.endsWith(ext) ? [p] : []); });
};
const kb = (n) => (n / 1024).toFixed(1);

async function snapshot() {
  const origin = (opt('origin') || '').replace(/\/$/, ''); const out = opt('out'); const pagesArg = opt('pages');
  if (!origin || !out || !pagesArg) { console.error('snapshot: --origin, --pages and --out are required'); process.exit(1); }
  let pages = existsSync(pagesArg) ? readFileSync(pagesArg, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : pagesArg.split(',');
  if (opt('only')) pages = pages.filter((p) => opt('only').split(',').includes(p));
  const widths = opt('widths', '1440,360').split(',').map(Number);
  const blockHosts = opt('block-hosts') ? new RegExp(opt('block-hosts')) : null;
  const consent = opt('consent'); const dismiss = (opt('dismiss') || '').split(',').filter(Boolean);
  mkdirSync(join(out, 'snap'), { recursive: true });
  const loadsFile = join(out, 'loads.json');
  const loads = existsSync(loadsFile) ? JSON.parse(readFileSync(loadsFile, 'utf8')) : {};
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const skip = argv.includes('--skip-existing');
  const jobs = pages.flatMap((p) => widths.map((w) => [p, w]))
    .filter(([p, w]) => !(skip && loads[`${p}@${w}`]?.files.length && existsSync(join(out, 'snap', `${slugOf(p)}@${w}.html.gz`))));
  const one = async (path, width) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const files = new Set(); const bad = [];
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (blockHosts && blockHosts.test(u.host)) return route.abort();
      return route.continue();
    });
    ctx.on('response', (r) => { const u = new URL(r.url()); if (u.origin === origin && /^\/blocks\/.+\.(css|js)$/.test(u.pathname)) { if (r.ok()) files.add(u.pathname); else bad.push(`${r.status()} ${u.pathname}`); } });
    const page = await ctx.newPage();
    try {
      const res = await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: 60000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);
      if (consent) await page.click(consent, { timeout: 4000 }).catch(() => {});
      for (const d of dismiss) await page.click(d, { timeout: 1000 }).catch(() => {});
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => { setTimeout(r, 50); }); }
        window.scrollTo(0, 0);
      });
      await page.waitForFunction(() => [...document.querySelectorAll('.block')].every((b) => b.dataset.blockStatus === 'loaded'), null, { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      const snap = await page.evaluate(() => {
        const d = document.documentElement.cloneNode(true);
        d.querySelectorAll('script, noscript, link[rel="stylesheet"], link[rel="modulepreload"], iframe').forEach((e) => e.remove());
        return { html: `<!doctype html>${d.outerHTML}`, notLoaded: [...document.querySelectorAll('.block')].filter((b) => b.dataset.blockStatus !== 'loaded').map((b) => b.className) };
      });
      if (bad.length) throw new Error(`block code not served: ${bad.slice(0, 3).join(', ')}`);
      writeFileSync(join(out, 'snap', `${slugOf(path)}@${width}.html.gz`), gzipSync(snap.html));
      loads[`${path}@${width}`] = { path, width, files: [...files].sort(), notLoaded: snap.notLoaded };
      return true;
    } finally { await ctx.close(); }
  };
  let next = 0; let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [p, w] = jobs[next]; next += 1;
      let ok = false;
      for (let a = 0; a < 4 && !ok; a += 1) {
        if (a) await new Promise((r) => { setTimeout(r, 5000 * 2 ** a); }); // a 429 burst backs off 10/20/40 s
        ok = await one(p, w).catch((e) => { console.error(`  ${p}@${w}: ${String(e.message).slice(0, 120)}`); return false; });
      }
      if (!ok) delete loads[`${p}@${w}`];
      done += 1; console.log(`[${done}/${jobs.length}] ${p}@${w} ${ok ? 'ok' : 'FAILED'}`);
    }
  };
  await Promise.all(Array.from({ length: Number(opt('concurrency', 3)) }, worker));
  await browser.close();
  writeFileSync(loadsFile, `${JSON.stringify(loads, null, 1)}\n`);
  console.log(`snapshot: ${Object.keys(loads).length} page-widths in ${loadsFile}`);
}

async function match() {
  const out = opt('out'); const blocksDir = opt('blocks', 'blocks');
  const loadsFile = join(out || '', 'loads.json');
  if (!out || !existsSync(loadsFile)) { console.error('match: no <out>/loads.json — run snapshot first'); process.exit(1); }
  const loads = JSON.parse(readFileSync(loadsFile, 'utf8'));
  const snaps = Object.entries(loads).map(([k, v]) => ({ k, ...v, file: join(out, 'snap', `${slugOf(v.path)}@${v.width}.html.gz`) })).filter((s) => existsSync(s.file));
  if (!snaps.length) { console.error('match: no snapshots'); process.exit(1); }
  const domClasses = new Set();
  for (const s of snaps) {
    s.html = gunzipSync(readFileSync(s.file)).toString('utf8');
    for (const m of s.html.matchAll(/\sclass="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) domClasses.add(c.replace(/&amp;/g, '&'));
  }
  const tok = { toggled: new Set(), prefixes: new Set(), literal: new Set(), anchors: new Set() };
  for (const dir of opt('js', 'blocks,scripts,widgets').split(',')) {
    for (const f of listFiles(dir, '.js')) { const t = jsClassTokens(readFileSync(f, 'utf8')); for (const k of Object.keys(tok)) t[k].forEach((x) => tok[k].add(x)); }
  }
  const isDyn = dynamicPredicate(tok, domClasses);
  const files = {}; const uniq = new Map();
  for (const f of listFiles(blocksDir, '.css')) {
    const key = `/${relative('.', f).split('\\').join('/')}`; const text = readFileSync(f, 'utf8');
    const rules = cssRules(text).map((r) => ({ ...r, relaxed: r.sels.map((s) => relaxSelector(s, isDyn)) }));
    for (const r of rules) for (const s of r.relaxed) if (!uniq.has(s)) uniq.set(s, uniq.size);
    files[key] = { text, rules };
  }
  const list = [...uniq.keys()];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  await ctx.route('**/*', (r) => r.abort());
  const page = await ctx.newPage();
  const perPage = {};
  for (const s of snaps) {
    await page.setContent(s.html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const hit = await page.evaluate((sels) => sels.map((q) => { try { return document.querySelector(q) ? 1 : 0; } catch { return 2; } }), list);
    const slot = perPage[s.path] || (perPage[s.path] = { files: new Set(), looks: new Set(), hit: new Uint8Array(list.length) });
    s.files.forEach((x) => slot.files.add(x));
    // a block's look = its first class after the name, as decorated (`<name> <look> block …`)
    for (const m of s.html.matchAll(/\sclass="([a-z0-9-]+)((?: [a-z0-9-]+)*?) block[ "]/g)) slot.looks.add(`${m[1]}|${m[2].trim().split(' ')[0] || ''}`);
    hit.forEach((h, i) => { if (h) slot.hit[i] = 1; });
    delete s.html;
  }
  await browser.close();
  const cov = { created: new Date().toISOString(), pages: Object.keys(perPage).length, files: {}, perPage: {} };
  const used = {}; const carry = [];
  for (const [key, f] of Object.entries(files)) {
    const block = key.split('/').slice(-2, -1)[0]; const owned = {};
    const rules = f.rules.map((r) => ({ sels: r.sels, ctx: r.ctx, bytes: r.end - r.start, hits: r.relaxed.map(() => 0) }));
    for (const [p, slot] of Object.entries(perPage)) {
      if (!slot.files.has(key)) continue;
      const parts = [];
      const looks = [...slot.looks].filter((x) => x.startsWith(`${block}|`)).map((x) => x.split('|')[1]);
      f.rules.forEach((r, i) => {
        let any = false; r.relaxed.forEach((s, j) => { if (slot.hit[uniq.get(s)]) { rules[i].hits[j] += 1; any = true; } });
        if (any) { parts.push(f.text.slice(r.start, r.end)); (owned[i] || (owned[i] = new Set())); looks.forEach((l) => owned[i].add(l)); }
      });
      (used[p] || (used[p] = {}))[key] = gz(parts.join('\n'));
    }
    const byLook = {};
    Object.entries(owned).forEach(([i, ls]) => { if (ls.size === 1) { const l = [...ls][0]; (byLook[l] || (byLook[l] = [])).push(f.text.slice(f.rules[i].start, f.rules[i].end)); } });
    const loaders = Object.values(perPage).filter((sl) => sl.files.has(key));
    for (const [l, txt] of Object.entries(byLook)) {
      const usedBy = loaders.filter((sl) => sl.looks.has(`${block}|${l}`)).length;
      carry.push({ block, look: l || '(none)', ownGz: gz(txt.join('\n')), usedBy, carriedBy: loaders.length - usedBy });
    }
    cov.files[key] = { hash: createHash('sha1').update(f.text).digest('hex'), bytes: Buffer.byteLength(f.text), gz: gz(f.text), rules };
  }
  const fileGz = (k) => (existsSync(`.${k}`) ? gz(readFileSync(`.${k}`)) : 0);
  const rows = Object.entries(perPage).map(([p, slot]) => {
    const fl = [...slot.files]; const css = fl.filter((x) => x.endsWith('.css')); const js = fl.filter((x) => x.endsWith('.js'));
    const cssGz = css.reduce((a, k) => a + fileGz(k), 0); const jsGz = js.reduce((a, k) => a + fileGz(k), 0);
    const cssUsed = css.reduce((a, k) => a + (used[p]?.[k] ?? fileGz(k)), 0);
    cov.perPage[p] = { requests: fl.length, cssGz, jsGz, cssUsedGz: cssUsed };
    return { p, total: cssGz + jsGz, css: cssGz, js: jsGz, used: cssUsed };
  });
  cov.carry = carry.sort((a, b) => b.ownGz * b.carriedBy - a.ownGz * a.carriedBy);
  writeFileSync(join(out, 'coverage.json'), `${JSON.stringify(cov)}\n`);
  const q = (k, x) => kb(quantile(rows.map((r) => r[k]), x));
  console.log(`match: ${snaps.length} snapshots, ${rows.length} pages, ${list.length} relaxed selectors, ${Object.keys(files).length} css files`);
  console.log(`block code gz KB/page  median ${q('total', 0.5)} · p90 ${q('total', 0.9)}  (css ${q('css', 0.5)} / ${q('css', 0.9)} · js ${q('js', 0.5)} / ${q('js', 0.9)}); css matching the page ${q('used', 0.5)} / ${q('used', 0.9)}`);
  const top = Object.entries(cov.files).map(([k, f]) => {
    const dead = f.rules.filter((r) => !r.hits.some(Boolean)).length; const pages = Object.values(perPage).filter((s) => s.files.has(k)).length;
    return { k, pages, gz: f.gz, rules: f.rules.length, dead };
  }).sort((a, b) => b.gz * b.pages - a.gz * a.pages).slice(0, Number(opt('top', 15)));
  for (const r of top) console.log(`  ${r.k.padEnd(48)} ${String(r.pages).padStart(3)} pages  ${kb(r.gz).padStart(6)} KB gz  rules ${r.rules} · matched nowhere ${r.dead}`);
  console.log('look carry — CSS only one look matches, on the pages that load its block without showing it:');
  for (const c of cov.carry.slice(0, Number(opt('top', 15)))) console.log(`  ${`${c.block}.${c.look}`.padEnd(40)} own ${kb(c.ownGz).padStart(5)} KB gz · shown on ${c.usedBy} · carried by ${c.carriedBy} pages`);
}

function prune() {
  const out = opt('out'); const covFile = join(out || '', 'coverage.json');
  if (!out || !existsSync(covFile)) { console.error('prune: no <out>/coverage.json — run match first'); process.exit(1); }
  const cov = JSON.parse(readFileSync(covFile, 'utf8'));
  const write = argv.includes('--write'); const report = {}; const total = { before: 0, after: 0 };
  let stale = 0;
  for (const [key, f] of Object.entries(cov.files)) {
    const path = `.${key}`; if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (createHash('sha1').update(text).digest('hex') !== f.hash) { console.error(`prune: ${key} changed since match — re-run match`); stale += 1; continue; }
    if (!f.rules.some((r) => r.hits.some(Boolean))) { console.log(`  ${key}: loaded by no snapshot page — left as is`); continue; }
    const res = pruneCss(text, (i, j) => f.rules[i].hits[j] > 0);
    const after = gz(res.text); total.before += f.gz; total.after += after;
    report[key] = { ...res.stats, gzBefore: f.gz, gzAfter: after, bytesBefore: f.bytes, bytesAfter: Buffer.byteLength(res.text), removed: res.removed };
    if (write && res.text !== text) writeFileSync(path, res.text);
  }
  writeFileSync(join(out, 'pruned.json'), `${JSON.stringify(report, null, 1)}\n`);
  const sum = (k) => Object.values(report).reduce((a, r) => a + r[k], 0);
  for (const [k, r] of Object.entries(report).sort((a, b) => (b[1].gzBefore - b[1].gzAfter) - (a[1].gzBefore - a[1].gzAfter)).slice(0, Number(opt('top', 15)))) {
    console.log(`  ${k.padEnd(48)} ${kb(r.gzBefore).padStart(6)} → ${kb(r.gzAfter).padStart(6)} KB gz  rules −${r.deadRules + r.overridden + r.empty} selectors −${r.deadSelectors} decls −${r.dupDecls}`);
  }
  console.log(`prune${write ? '' : ' (dry run)'}: ${Object.keys(report).length} files, gz ${kb(total.before)} → ${kb(total.after)} KB; rules matched nowhere ${sum('deadRules')}, selectors ${sum('deadSelectors')}, overridden ${sum('overridden')}, empty ${sum('empty')}, duplicate declarations ${sum('dupDecls')}, empty groups ${sum('groups')}`);
  if (stale) process.exit(1);
}

if (isMain) {
  const cmd = argv[0];
  if (cmd === 'snapshot') await snapshot();
  else if (cmd === 'match') await match();
  else if (cmd === 'prune') prune();
  else { console.error(`css-coverage: unknown command ${cmd} — snapshot | match | prune (--help)`); process.exit(1); }
}
