#!/usr/bin/env node
/**
 * rollout/block-audit.mjs — block or variant, measured (#142): every block × variant of a project
 * with the evidence the deploy rule (SKILL.md Step 2 § Block, variant or merge) decides on, and a
 * MERGE / PROMOTE / RENAME / KEEP recommendation per variant.
 *
 * Per variant (the first class after the block name; further classes are modifiers):
 *   model     content-model signature from the DA documents: columns, and per row the role of each
 *             cell (H heading · P paragraph · CTA link paragraph · IMG picture · LIST · TABLE · KEY a
 *             short plain first cell · T bare text · ∅ empty), consecutive repeats collapsed (`P+`,
 *             a repeated row `(…)*`); compared as the Jaccard of column-role tokens (column-free
 *             when a variant's own instances differ in column count, as data tables do).
 *   skeleton  the element tree `decorate()` builds on the first instance (linkedom, project
 *             `blocks/<b>/<b>.js`, file-URL code base, CSS loads resolved at once, fetch refused):
 *             tags + classes, block and variant names stripped, repeated siblings collapsed; hashed,
 *             compared as the Jaccard of root-to-node paths. `--no-decorate` or a throw: `error`, and
 *             the comparison falls back to the model.
 *   css       bytes, property set, rules whose selectors never name the variant (`unscoped`),
 *             `@import`s; compared as the Jaccard of `media|selector{prop:value}` tokens with the
 *             block and variant classes normalised. Source: `variants/<v>.css` of a variant-host
 *             block, else the rules of `blocks/<b>/<b>.css` whose selector names `.<v>`.
 *   usage     instances, pages; `extends` = the variants its JS imports or its CSS @imports.
 * Families: variants of one block whose model AND skeleton agree (single linkage) — the largest
 * family is the block, every other family is a PROMOTE candidate (its own block). Inside a family a
 * pair whose CSS agrees ≥ --merge (default 0.85) is a MERGE. A name led by a scope token — one that
 * leads variant names in ≥ 3 blocks, carries a digit (`unit1-`), or is passed in --scope-tokens —
 * is a RENAME (name it after the look or role). The rest KEEP. Static evidence: a MERGE is confirmed
 * by the gate (pixel) after it lands.
 * Requests: per page, the block CSS + JS requests now (a variant host adds 2 per distinct variant
 * plus its `extends` chain) vs standard EDS (2 per distinct block).
 *
 * Usage: node block-audit.mjs [--content content] [--blocks blocks] [--json <file>]
 *          [--no-decorate] [--merge 0.85] [--model 0.5] [--skeleton 0.7] [--scope-tokens a,b]
 *          [--block <name>] [--max-rows 40]
 * Prints a table per block (variant · uses · model · skeleton · css · action) and one summary line
 * `block-audit: N blocks, N variants — merge N · promote N · rename N · keep N; requests/page A → B`.
 * linkedom (decorate) resolves from this folder, then from the cwd's package.json; absent → the
 * skeleton column reads `n/a`. Exit 0 always after a run (the audit recommends; the agent decides),
 * 1 usage / no documents.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// --help prints this file's usage header, so an agent never reads the source to learn the flags.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const header = src.match(/\/\*\*[\s\S]*?\*\//);
  console.log(header ? header[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim() : 'no usage header');
  process.exit(0);
}

// ---- HTML primitives (no DOM: the pure part runs without linkedom) ------------------------------
const VOID = new Set(['img', 'br', 'source', 'hr', 'input', 'meta', 'link', 'wbr', 'col', 'area', 'embed', 'track']);

/** Top-level elements of an HTML fragment: [{ tag, attrs, inner }]; bare text → { tag: '#text' }. */
export function topChildren(html) {
  const out = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g;
  let depth = 0; let open = null; let last = 0; let m;
  while ((m = re.exec(html))) {
    const [, close, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (depth === 0 && !close) {
      const text = html.slice(last, m.index).replace(/<!--[\s\S]*?-->/g, '').trim();
      if (text) out.push({ tag: '#text', attrs: '', inner: text });
    }
    if (close) {
      depth -= 1;
      if (depth === 0 && open) { out.push({ tag: open.tag, attrs: open.attrs, inner: html.slice(open.end, m.index) }); open = null; last = re.lastIndex; }
      if (depth < 0) depth = 0;
    } else if (VOID.has(tag) || selfClose) {
      if (depth === 0) { out.push({ tag, attrs, inner: '' }); last = re.lastIndex; }
    } else {
      if (depth === 0) open = { tag, attrs, end: re.lastIndex };
      depth += 1;
    }
  }
  const tail = html.slice(last).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim();
  if (tail && depth === 0) out.push({ tag: '#text', attrs: '', inner: tail });
  return out;
}

const classOf = (attrs) => { const m = /class="([^"]*)"/i.exec(attrs || ''); return m ? m[1].trim().split(/\s+/).filter(Boolean) : []; };
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/** The role of one top-level element of a cell. */
export function roleOf(node) {
  const { tag, inner } = node;
  if (tag === '#text') return 'T';
  if (/^h[1-6]$/.test(tag)) return 'H';
  if (tag === 'picture' || tag === 'img') return 'IMG';
  if (tag === 'ul' || tag === 'ol') return 'LIST';
  if (tag === 'table') return 'TABLE';
  if (tag === 'p') {
    const kids = topChildren(inner).filter((k) => k.tag !== 'br');
    const only = kids.length === 1 ? kids[0] : null;
    const unwrap = only && ['strong', 'em'].includes(only.tag) ? topChildren(only.inner) : null;
    const leaf = unwrap && unwrap.length === 1 ? unwrap[0] : only;
    if (leaf && (leaf.tag === 'picture' || leaf.tag === 'img')) return 'IMG';
    if (leaf && leaf.tag === 'a' && textOf(inner) === textOf(leaf.inner)) return 'CTA';
    return 'P';
  }
  return tag;
}

/** The role string of a cell: roles in order, consecutive repeats collapsed (`H.P+.CTA`), '∅' empty. */
export function cellRoles(cellHtml, { firstCell = false } = {}) {
  const kids = topChildren(cellHtml);
  if (!kids.length) return '∅';
  if (firstCell && kids.length === 1 && kids[0].tag !== 'p' && kids[0].tag === '#text' && textOf(kids[0].inner).split(' ').length <= 3) return 'KEY';
  if (firstCell && kids.length === 1 && kids[0].tag === 'p' && roleOf(kids[0]) === 'P' && !/<(a|img|picture)\b/i.test(kids[0].inner) && textOf(kids[0].inner).split(' ').length <= 3) return 'KEY';
  const roles = kids.map(roleOf);
  const out = [];
  for (const r of roles) {
    const prev = out[out.length - 1];
    if (prev === r || prev === `${r}+`) out[out.length - 1] = `${r}+`;
    else out.push(r);
  }
  return out.join('.');
}

// ---- documents → block instances → content models ------------------------------------------------
const divsOf = (html) => topChildren(html).filter((n) => n.tag === 'div');

/** Every block instance of a DA document: [{ block, classes, rows: [[cellHtml]] }]. */
export function blockInstances(html) {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  const out = [];
  for (const section of divsOf(main ? main[1] : html)) {
    for (const b of divsOf(section.inner)) {
      const cls = classOf(b.attrs);
      if (!cls.length || ['metadata', 'section-metadata'].includes(cls[0])) continue;
      out.push({ block: cls[0], classes: cls.slice(1), rows: divsOf(b.inner).map((r) => divsOf(r.inner).map((c) => c.inner)) });
    }
  }
  return out;
}

/** An instance's model: cols, the shape string (repeated rows collapsed) and its column-role tokens. */
export function instanceModel(rows) {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const rowSigs = rows.map((r) => r.map((c, i) => cellRoles(c, { firstCell: i === 0 && r.length > 1 })).join(' | '));
  const shape = [];
  for (const s of rowSigs) {
    const prev = shape[shape.length - 1];
    if (prev === s || prev === `(${s})*`) shape[shape.length - 1] = `(${s})*`;
    else shape.push(s);
  }
  const tokens = new Set([`cols:${cols}`]);
  rows.forEach((r) => r.forEach((c, i) => cellRoles(c, { firstCell: i === 0 && r.length > 1 }).split('.').forEach((role) => tokens.add(`c${i}:${role.replace(/\+$/, '')}`))));
  return { cols, shape: shape.join(' / '), tokens };
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a); const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 1;
  let n = 0; for (const x of A) if (B.has(x)) n += 1;
  return n / (A.size + B.size - n);
}

// ---- CSS ---------------------------------------------------------------------------------------
/** A selector list split on its top-level commas (never inside `:is(a, b)` / `:where(…)` / `[a=","]`). */
export function splitSelectors(list) {
  const out = []; let depth = 0; let cur = ''; let quote = null;
  for (const ch of list) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** Flat rules of a stylesheet: [{ media, selectors, decls: [[prop, value]] }] + imports + at-rule count. */
export function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = [...src.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)].map((m) => m[1]);
  const rules = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).replace(/@import[^;]*;/g, '').trim();
      let depth = 1; let j = open + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; j += 1; }
      const body = text.slice(open + 1, j - 1);
      if (/^@(media|supports|container|layer)\b/.test(head)) walk(body, `${media}${head.replace(/\s+/g, ' ')};`);
      else if (!/^@/.test(head) && head) {
        const decls = body.split(';').map((d) => d.trim()).filter((d) => d.includes(':') && !d.includes('{'))
          .map((d) => { const k = d.indexOf(':'); return [d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim().replace(/\s+/g, ' ')]; });
        rules.push({ media, selectors: splitSelectors(head), decls });
      }
      i = j;
    }
  };
  walk(src, '');
  return { rules, imports };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** CSS evidence of one variant: bytes, props, unscoped rules, comparison tokens. */
export function cssEvidence(css, { block, variant, variantNames = [] }) {
  const { rules, imports } = parseCss(css || '');
  const names = [...new Set([variant, ...variantNames])].filter(Boolean).sort((a, b) => b.length - a.length);
  const norm = (sel) => names.reduce((s, v) => s.replace(new RegExp(`\\.${escRe(v)}(?![\\w-])`, 'g'), '.V'), sel.replace(new RegExp(`\\.${escRe(block)}(?![\\w-])`, 'g'), '.B'));
  const own = new RegExp(`\\.${escRe(variant)}(?![\\w-])`);
  const tokens = new Set(); const props = new Set(); let unscoped = 0;
  for (const r of rules) {
    if (!r.selectors.some((s) => own.test(s))) unscoped += 1;
    const sel = r.selectors.map(norm).sort().join(',');
    for (const [p, v] of r.decls) { props.add(p); tokens.add(`${r.media}|${sel}{${p}:${v}}`); }
  }
  return { bytes: Buffer.byteLength(css || ''), rules: rules.length, props: [...props].sort(), unscoped, imports, tokens };
}

/** Rules of a whole block sheet that name `.variant` (the standard EDS layout: variants inside <b>.css). */
export function variantSlice(css, variant) {
  const own = new RegExp(`\\.${escRe(variant)}(?![\\w-])`);
  return parseCss(css).rules.filter((r) => r.selectors.some((s) => own.test(s)))
    .map((r) => `${r.media ? `@media ${r.media} ` : ''}${r.selectors.join(',')}{${r.decls.map(([p, v]) => `${p}:${v}`).join(';')}}`).join('\n');
}

/** Sibling variants a variant module pulls in: static imports, loadCSS of variants/<x>.css. */
export function jsExtends(js) {
  const out = new Set();
  for (const m of (js || '').matchAll(/from\s+['"]\.\/([\w-]+)\.js['"]/g)) out.add(m[1]);
  for (const m of (js || '').matchAll(/variants\/([\w-]+)\.css/g)) out.add(m[1]);
  return [...out];
}

// ---- decorate skeleton (linkedom) ----------------------------------------------------------------
/** The skeleton of a decorated element: nested [tag.classes] with block/variant names stripped. */
export function skeletonOf(el, strip = new Set()) {
  const name = (n) => `${n.tagName.toLowerCase()}${[...n.classList].filter((c) => !strip.has(c) && !/^(block|button|button-container)$/.test(c)).sort().map((c) => `.${c}`).join('')}`;
  const walk = (n) => {
    const kids = [];
    for (const k of n.children) {
      const s = walk(k);
      const prev = kids[kids.length - 1];
      if (prev && (prev.sig === s.sig)) prev.rep = true; else kids.push(s);
    }
    const sig = `${name(n)}(${kids.map((k) => `${k.sig}${k.rep ? '*' : ''}`).join(',')})`;
    return { sig, name: name(n), kids };
  };
  const tree = walk(el);
  // Similarity reads TAG paths: class names follow each source cascade, the structure is the skeleton.
  const paths = new Set(); const classed = new Set();
  const collect = (t, prefix, cprefix) => {
    const tag = t.name.split('.')[0];
    const p = prefix ? `${prefix}>${tag}` : tag; const c = cprefix ? `${cprefix}>${t.name}` : t.name;
    paths.add(p); classed.add(c); t.kids.forEach((k) => collect(k, p, c));
  };
  tree.kids.forEach((k) => collect(k, '', ''));
  const behaviour = [...new Set([...el.querySelectorAll('form, input, select, textarea, button, details, dialog, iframe, video, canvas')].map((n) => n.tagName.toLowerCase()))].sort().join(',');
  return { hash: createHash('sha1').update(tree.sig).digest('hex').slice(0, 10), paths, nodes: classed.size, behaviour };
}

async function loadParseHTML() {
  try { return (await import('linkedom')).parseHTML; } catch { /* try the project */ }
  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    return (await import(pathToFileURL(req.resolve('linkedom')).href)).parseHTML;
  } catch { return null; }
}

/** A decorate runner over one linkedom window, or null without linkedom. */
async function decorateRunner(root) {
  const parseHTML = await loadParseHTML();
  if (!parseHTML) return null;
  const { window, document } = parseHTML('<!doctype html><html><head></head><body><header></header><main></main><footer></footer></body></html>');
  const g = globalThis;
  const define = (k, v) => { try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } catch { /* read-only */ } };
  const noopObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.location = new URL('https://localhost/'); window.origin = 'https://localhost';
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.IntersectionObserver = noopObserver; window.ResizeObserver = noopObserver; window.MutationObserver = window.MutationObserver || noopObserver;
  window.requestAnimationFrame = (f) => setTimeout(f, 0); window.cancelAnimationFrame = clearTimeout;
  window.getComputedStyle = window.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
  window.scrollTo = () => {}; window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  window.hlx = { codeBasePath: pathToFileURL(root).href.replace(/\/$/, '') };
  for (const k of ['window', 'document', 'location', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'DocumentFragment', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'navigator', 'localStorage', 'sessionStorage']) {
    define(k, k === 'window' ? window : k === 'document' ? document : window[k] ?? (k.endsWith('Storage') ? { getItem: () => null, setItem() {}, removeItem() {} } : undefined));
  }
  define('fetch', window.fetch);
  // loadCSS waits for <link>.onload: resolve every stylesheet appended to <head> at once.
  const append = document.head.append.bind(document.head);
  document.head.append = (...nodes) => { append(...nodes); nodes.forEach((n) => n && typeof n.onload === 'function' && setTimeout(() => n.onload(), 0)); };
  const aem = join(root, 'scripts', 'aem.js');
  if (existsSync(aem)) { try { await import(pathToFileURL(aem).href); } catch { /* best effort */ } window.hlx.codeBasePath = pathToFileURL(root).href.replace(/\/$/, ''); }
  process.on('unhandledRejection', () => {});
  return async (blockName, classes, rows, strip) => {
    const file = join(root, 'blocks', blockName, `${blockName}.js`);
    if (!existsSync(file)) return { error: 'no block js' };
    const main = document.querySelector('main');
    const rowsHtml = rows.map((r) => `<div>${r.map((c) => `<div>${c}</div>`).join('')}</div>`).join('');
    main.innerHTML = `<div class="section"><div class="${blockName}-wrapper"><div class="${[blockName, ...classes, 'block'].join(' ')}" data-block-name="${blockName}" data-block-status="loading">${rowsHtml}</div></div></div>`;
    const el = main.querySelector(`.${blockName}`);
    try {
      const mod = await import(pathToFileURL(file).href);
      await Promise.race([Promise.resolve(mod.default(el)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 4 s')), 4000))]);
      return skeletonOf(el, strip);
    } catch (e) { return { error: String(e && e.message || e).slice(0, 120) }; }
  };
}

// ---- recommendations (pure) -----------------------------------------------------------------------
/** Scope tokens: a first segment leading variant names in ≥ 3 blocks, or carrying a digit, or passed. */
export function scopeTokens(namesByBlock, extra = []) {
  const lead = new Map();
  for (const [b, names] of namesByBlock) {
    for (const n of names) {
      const segs = n.split('-');
      if (segs.length < 2) continue;
      if (!lead.has(segs[0])) lead.set(segs[0], new Set());
      lead.get(segs[0]).add(b);
    }
  }
  const out = new Set(extra);
  for (const [t, bs] of lead) if (bs.size >= 3 || /\d/.test(t)) out.add(t);
  return out;
}

/**
 * Families, merges and per-variant actions of one block. `variants`: [{ name, instances, model:{cols,
 * tokens}, skeleton:{paths}|{error}, css:{tokens}, extends: [] }] (css.tokens already the effective
 * chain). Returns { families: [[name]], actions: { name: {action, target?, why} }, recs: [] }.
 */
export function recommend(block, variants, { modelT = 0.5, skelT = 0.7, mergeT = 0.85, scope = new Set() } = {}) {
  const by = new Map(variants.map((v) => [v.name, v]));
  const parent = new Map(variants.map((v) => [v.name, v.name]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  const union = (a, b) => parent.set(find(a), find(b));
  // a block whose column count varies between its own instances (a data table) is not keyed on columns
  const loose = (t) => new Set([...t].map((x) => x.replace(/^c\d+:/, 'c:')).filter((x) => !x.startsWith('cols:')));
  const modelSim = (a, b) => {
    if (a.model.colsVary || b.model.colsVary) return jaccard(loose(a.model.tokens), loose(b.model.tokens));
    return a.model.cols === b.model.cols ? jaccard(a.model.tokens, b.model.tokens) : 0;
  };
  const skelSim = (a, b) => (a.skeleton && a.skeleton.paths && b.skeleton && b.skeleton.paths ? jaccard(a.skeleton.paths, b.skeleton.paths) : null);
  const pairs = [];
  for (const a of variants) {
    for (const b of variants) {
      if (a.name >= b.name) continue;
      const linked = (a.extends || []).includes(b.name) || (b.extends || []).includes(a.name);
      const s = skelSim(a, b);
      pairs.push({ a: a.name, b: b.name, model: Number(modelSim(a, b).toFixed(2)), skeleton: s === null ? null : Number(s.toFixed(2)), css: Number(jaccard(a.css.tokens, b.css.tokens).toFixed(2)), linked });
      const sameBehaviour = !a.skeleton || !b.skeleton || a.skeleton.error || b.skeleton.error || a.skeleton.behaviour === b.skeleton.behaviour;
      if (linked || (modelSim(a, b) >= modelT && sameBehaviour)) union(a.name, b.name);
    }
  }
  const groups = new Map();
  for (const v of variants) { const r = find(v.name); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v.name); }
  const uses = (names) => names.reduce((n, x) => n + by.get(x).instances, 0);
  const families = [...groups.values()].sort((x, y) => uses(y) - uses(x) || x[0].localeCompare(y[0]));
  const actions = {}; const recs = [];
  const main = families[0] || [];
  for (const fam of families.slice(1)) {
    const best = (n) => Math.max(0, ...main.map((m) => modelSim(by.get(n), by.get(m))));
    const why = fam.map((n) => `${n}: model ${best(n).toFixed(2)} vs the ${block} family`).join('; ');
    recs.push({ action: 'PROMOTE', block, variants: fam, why: `a different content model or behaviour — ${why}` });
    fam.forEach((n) => { actions[n] = { action: 'PROMOTE', family: fam, why }; });
  }
  for (const fam of families) {
    const sorted = [...fam].sort((x, y) => by.get(y).instances - by.get(x).instances || x.localeCompare(y));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = by.get(sorted[i]); const b = by.get(sorted[j]);
        if (actions[b.name] && actions[b.name].action === 'MERGE') continue;
        const c = jaccard(a.css.tokens, b.css.tokens);
        const sk = skelSim(a, b);
        if (c >= mergeT && a.model.shape === b.model.shape && (sk === null || sk >= skelT)) {
          recs.push({ action: 'MERGE', block, variants: [b.name], into: a.name, why: `css ${c.toFixed(2)}, skeleton ${sk === null ? 'n/a' : sk.toFixed(2)}, same model shape` });
          const fam0 = actions[b.name] && actions[b.name].family;
          actions[b.name] = { action: 'MERGE', into: a.name, why: `css ${c.toFixed(2)}`, ...(fam0 ? { family: fam0 } : {}) };
        }
      }
    }
  }
  for (const v of variants) {
    if (actions[v.name]) continue;
    if (scope.has(v.name.split('-')[0]) && v.name.includes('-')) {
      actions[v.name] = { action: 'RENAME', why: `led by the scope token "${v.name.split('-')[0]}" — name it after the look or role` };
      recs.push({ action: 'RENAME', block, variants: [v.name], why: actions[v.name].why });
    } else actions[v.name] = { action: 'KEEP' };
  }
  return { families, actions, recs, pairs };
}

/** Requests per page for block code: now (variant host: +2 per distinct variant and its chain) vs standard. */
export function requestCost(pageInstances, hostBlocks, extendsOf) {
  const blocks = new Set(pageInstances.map((i) => i.block));
  let now = 2 * blocks.size;
  const seen = new Set();
  const add = (b, v) => { const k = `${b}/${v}`; if (seen.has(k)) return; seen.add(k); now += 2; (extendsOf(b, v) || []).forEach((x) => add(b, x)); };
  for (const i of pageInstances) if (hostBlocks.has(i.block) && i.classes[0]) add(i.block, i.classes[0]);
  return { now, standard: 2 * blocks.size };
}

// ---- CLI ----------------------------------------------------------------------------------------
const listHtml = (dir) => {
  const out = [];
  const walk = (d) => { for (const f of readdirSync(d)) { if (f.startsWith('.')) continue; const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.html')) out.push(p); } };
  if (existsSync(dir)) walk(dir);
  return out.sort();
};
const readOr = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const mostFrequent = (arr) => { const m = new Map(); arr.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const contentDir = opt('content', 'content'); const blocksDir = opt('blocks', 'blocks');
  const only = opt('block', null); const maxRows = Number(opt('max-rows', 40));
  const th = { modelT: Number(opt('model', 0.5)), skelT: Number(opt('skeleton', 0.7)), mergeT: Number(opt('merge', 0.85)) };
  const docs = listHtml(contentDir);
  if (!docs.length) { console.error(`block-audit: no documents under ${contentDir}`); process.exit(1); }
  const root = join(blocksDir, '..');
  const pages = []; const byBlock = new Map();
  for (const f of docs) {
    const inst = blockInstances(readFileSync(f, 'utf8'));
    const page = `/${relative(contentDir, f).replace(/\.html$/, '').replace(/(^|\/)index$/, '$1')}`;
    pages.push({ page, instances: inst });
    for (const i of inst) {
      if (only && i.block !== only) continue;
      const v = i.classes[0] || '(default)';
      if (!byBlock.has(i.block)) byBlock.set(i.block, new Map());
      const m = byBlock.get(i.block);
      if (!m.has(v)) m.set(v, { name: v, instances: 0, pages: new Set(), modifiers: new Set(), samples: [] });
      const e = m.get(v); e.instances += 1; e.pages.add(page); i.classes.slice(1).forEach((c) => e.modifiers.add(c)); e.samples.push(i);
    }
  }
  const scope = scopeTokens([...byBlock].map(([b, m]) => [b, [...m.keys()]]), (opt('scope-tokens', '') || '').split(',').filter(Boolean));
  const run = argv.includes('--no-decorate') ? null : await decorateRunner(root);
  const report = { generatedAt: new Date().toISOString(), content: contentDir, blocks: [], totals: { merge: 0, promote: 0, rename: 0, keep: 0 } };
  const hostBlocks = new Set(); const extendsMap = new Map();
  for (const [block, m] of [...byBlock].sort((a, b) => a[0].localeCompare(b[0]))) {
    const vdir = join(blocksDir, block, 'variants');
    const host = existsSync(vdir) && /variants\//.test(readOr(join(blocksDir, block, `${block}.js`)));
    if (host) hostBlocks.add(block);
    const names = [...m.keys()];
    const sheet = readOr(join(blocksDir, block, `${block}.css`));
    const variants = [];
    for (const e of m.values()) {
      const css = host ? readOr(join(vdir, `${e.name}.css`)) : variantSlice(sheet, e.name);
      const js = host ? readOr(join(vdir, `${e.name}.js`)) : '';
      const cssEv = cssEvidence(css, { block, variant: e.name, variantNames: names });
      const ext = [...new Set([...jsExtends(js), ...cssEv.imports.map((p) => p.replace(/^.*\//, '').replace(/\.css$/, ''))])].filter((x) => x !== e.name && (!host || existsSync(join(vdir, `${x}.css`)) || existsSync(join(vdir, `${x}.js`))));
      const models = e.samples.map((s) => instanceModel(s.rows));
      const tokens = new Set(); models.forEach((x) => x.tokens.forEach((t) => tokens.add(t)));
      const strip = new Set([block, ...names, ...e.modifiers, `${block}-wrapper`, `${block}-container`]);
      const skeleton = run ? await run(block, [e.name, ...e.modifiers].filter((c) => c !== '(default)'), e.samples[0].rows, strip) : { error: 'n/a' };
      variants.push({ name: e.name, instances: e.instances, pages: [...e.pages].sort(), modifiers: [...e.modifiers], extends: ext, js: { bytes: Buffer.byteLength(js) },
        model: { cols: mostFrequent(models.map((x) => x.cols)), colsVary: new Set(models.map((x) => x.cols)).size > 1, shape: mostFrequent(models.map((x) => x.shape)), tokens },
        skeleton, css: cssEv, cssOwn: cssEv.tokens });
      extendsMap.set(`${block}/${e.name}`, ext);
    }
    const byName = new Map(variants.map((v) => [v.name, v]));
    const chain = (n, seen = new Set()) => { if (seen.has(n) || !byName.has(n)) return seen; seen.add(n); byName.get(n).extends.forEach((x) => chain(x, seen)); return seen; };
    for (const v of variants) { const t = new Set(); chain(v.name).forEach((n) => byName.get(n).cssOwn.forEach((x) => t.add(x))); v.css = { ...v.css, tokens: t }; }
    const { families, actions, recs, pairs } = recommend(block, variants, { ...th, scope });
    for (const v of variants) report.totals[actions[v.name].action.toLowerCase()] += 1;
    report.blocks.push({ block, variantHost: host, families, recommendations: recs, pairs,
      variants: variants.map((v) => ({ name: v.name, instances: v.instances, pages: v.pages, modifiers: v.modifiers, extends: v.extends, action: actions[v.name],
        model: { cols: v.model.cols, shape: v.model.shape }, skeleton: v.skeleton.error ? { error: v.skeleton.error } : { hash: v.skeleton.hash, nodes: v.skeleton.nodes, behaviour: v.skeleton.behaviour },
        css: { bytes: v.css.bytes, rules: v.css.rules, props: v.css.props.length, unscoped: v.css.unscoped, imports: v.css.imports }, js: v.js })) });
  }
  const costs = pages.map((p) => ({ page: p.page, ...requestCost(p.instances, hostBlocks, (b, v) => extendsMap.get(`${b}/${v}`)) }));
  const mean = (k) => (costs.length ? costs.reduce((n, c) => n + c[k], 0) / costs.length : 0);
  report.requests = { perPage: costs, meanNow: Number(mean('now').toFixed(1)), meanStandard: Number(mean('standard').toFixed(1)), variantHostBlocks: [...hostBlocks].sort() };
  for (const b of report.blocks) {
    console.log(`\n${b.block}${b.variantHost ? ' (variant host)' : ''} — ${b.variants.length} variant(s), ${b.families.length} famil${b.families.length === 1 ? 'y' : 'ies'}`);
    for (const v of b.variants.slice(0, maxRows)) {
      const a = v.action; const act = a.action + (a.into ? ` → ${a.into}` : '');
      console.log(`  ${v.name.padEnd(26)} ${String(v.instances).padStart(4)}×  cols ${v.model.cols}  ${(v.skeleton.hash || `skel ${v.skeleton.error}`).slice(0, 18).padEnd(18)} css ${String(v.css.bytes).padStart(6)} B  ${act}`);
    }
  }
  const t = report.totals;
  console.log(`\nblock-audit: ${report.blocks.length} blocks, ${report.blocks.reduce((n, b) => n + b.variants.length, 0)} variants — merge ${t.merge} · promote ${t.promote} · rename ${t.rename} · keep ${t.keep}; requests/page ${report.requests.meanNow} → ${report.requests.meanStandard} (standard EDS)`);
  const jsonOut = opt('json', null);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(`block-audit: ${e.stack || e.message}`); process.exit(1); });
