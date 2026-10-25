#!/usr/bin/env node
/**
 * migrate/import-run.mjs — run the PROJECT's importer (the AEM importer convention) headless and
 * write the DA documents of a template's pages (#140).
 *
 * The encoder of a template is project code: `tools/importer/page-templates.json` (template id →
 * `urls` [exact] and/or `patterns` [path globs, `*` one segment, `**` any] → `import-<id>.js`, or
 * the template's `script`), `import-<id>.js` (ESM default export `{ transform(payload) }` returning
 * `[{ element, path, report }]`, or `{ transformDOM(payload) }` + optional `generateDocumentPath`),
 * `parsers/<block>[-<variant>].js` (`parse(element, { document, url, params })` replacing the element
 * with `WebImporter.Blocks.createBlock(document, { name, cells })`) and `transformers/*.js`. This
 * driver gives those scripts the payload the AEM importer gives them, so the same files run there.
 *
 * Payload: { document, url, html, params } — `document` is built from the capture
 * `<current>/pages/<slug>.html` (or the live URL with --fetch); `params` = { originalURL, slug,
 * template, capture (the capture JSON or null), source }. `params.source` is the STRUCTURED SOURCE
 * read from the HTML before any DOM work: { nextData (the Next.js `__NEXT_DATA__` object, from
 * `<script id="__NEXT_DATA__">` or a `__NEXT_DATA__ = {…}` assignment), jsonLd [every
 * application/ld+json object], meta { <name|property>: content }, title, external (the
 * --source-json record: the entry keyed by the slug, the URL or its path, else the whole file) }.
 * A parser that has the CMS record reads it instead of scraping the rendered DOM.
 * WebImporter shim (global): Blocks.createBlock / getMetadataBlock, DOMUtils.remove / createTable,
 * rules.createMetadata / adjustImageUrls / transformBackgroundImages, FileUtils.sanitizePath.
 * Tables become EDS div blocks (`Cards (news, dark)` → class "cards news dark"), a top-level `<hr>`
 * starts a section, attribute-less wrapper divs unwrap.
 *
 * Content-count acceptance per page (the import-time half of the sibling tier's row 4): the
 * capture's headings, text runs, CTAs (label and href) and images inside the scope — the script's
 * `report.scope`, else the template's `scope`, else `main`, else body — must each appear in the
 * written document. An item inside an
 * element the script removed with `WebImporter.DOMUtils.remove(…, selectors)`, or matched by a
 * `report.deviations[]` entry ({ kind, selector | text, reason }), is a declared drop; any other
 * missing item fails the page (exit 2).
 * Template parts authored once (#143): a result whose path starts `/fragments/` is a fragment
 * document, written once per run — the same path emitted with other content by a later page fails
 * that page (the part is not verbatim). The count credits every fragment the page uses: the
 * `/fragments/` links in its document plus `report.fragments[]` (parts template code injects), read
 * from this run, else `<out><path>.html`; a fragment found nowhere fails the page.
 *
 * Usage:
 *   node import-run.mjs --template <id> --slugs a,b [options]
 *   node import-run.mjs --all-of <id> [options]
 *   node import-run.mjs --template <id> --url <url> [options]      (no state page: needs --fetch)
 *   node import-run.mjs --list                                      templates × matched state pages
 * Options:
 *   --importer <dir>        default tools/importer
 *   --state <file>          default stardust/state.json (slug → url)
 *   --current <dir>         default stardust/current (pages/<slug>.html + .json)
 *   --out <dir>             default content; writes <out><path>.html (path `/` → /index)
 *   --source auto|next-data|json-ld|none   adapters run for params.source (default auto = all)
 *   --source-json <file>    a CMS export / API dump → params.source.external
 *   --fetch                 build the DOM from the live URL instead of the capture
 *   --compare <dir>         structural compare with the documents already in <dir> (same path):
 *                           sections, blocks (rows × cols), text set, images, links per section
 *   --dry-run               write nothing; --json <file> the per-page results
 *   --max-lines <n>         drop / diff lines printed per page (default 8)
 * Prints one line per page `ok|FAIL|ERROR <slug> → <file>  h a/b · text a/b · cta a/b · img a/b
 *   [declared n] [= same | ≠ n diffs]`, the missing items under a FAIL, then one summary line
 *   `import-run <id>: imported N, failed N, errors N[, compared N same / N differ] → <out>`.
 * DOM: `linkedom`, resolved from this script's folder, then from the cwd's package.json — a project
 *   devDependency (the plugin ships no node_modules). Importer `.js` files load as ESM: keep a
 *   `{"type": "module"}` package.json in the importer folder.
 * Exit: 0 clean · 2 a page failed the content count or threw · 3 compare differences only ·
 *   1 usage error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function help() {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const header = src.match(/\/\*\*[\s\S]*?\*\//);
  return header ? header[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim() : 'no usage header';
}

// ---- pure helpers -------------------------------------------------------------------------------

const VALUE_FLAGS = ['template', 'slugs', 'all-of', 'url', 'importer', 'state', 'current', 'out', 'source', 'source-json', 'compare', 'json', 'max-lines'];
const BOOL_FLAGS = ['fetch', 'dry-run', 'list'];

export function parseArgs(argv) {
  const o = { importer: 'tools/importer', state: 'stardust/state.json', current: 'stardust/current', out: 'content', source: 'auto', 'max-lines': '8', urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const k = a.slice(2);
    if (BOOL_FLAGS.includes(k)) { o[k] = true; continue; }
    if (!VALUE_FLAGS.includes(k)) throw new Error(`unknown flag ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    i += 1;
    if (k === 'url') o.urls.push(v); else o[k] = v;
  }
  if (!['auto', 'next-data', 'json-ld', 'none'].includes(o.source)) throw new Error(`--source must be auto|next-data|json-ld|none, got "${o.source}"`);
  if (!o.list && !o.template && !o['all-of']) throw new Error('one of --template <id>, --all-of <id> or --list is required');
  if (o.template && !o.slugs && !o.urls.length) throw new Error('--template needs --slugs a,b or --url <url>');
  if (!/^\d+$/.test(o['max-lines'])) throw new Error('--max-lines must be a number');
  return o;
}

/** The JSON object starting at s[i] ('{'), string- and escape-aware; null when unbalanced. */
export function balancedJson(s, i) {
  let depth = 0; let inStr = false; let esc = false;
  for (let k = i; k < s.length; k += 1) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return s.slice(i, k + 1); }
  }
  return null;
}

const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Source adapters: each reads the raw HTML string (no DOM) and returns its part of params.source. */
export const SOURCE_ADAPTERS = {
  'next-data': (html) => {
    const tag = html.match(/<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    try {
      if (tag) return { nextData: JSON.parse(tag[1]) };
      const at = html.search(/__NEXT_DATA__\s*=\s*\{/);
      if (at < 0) return { nextData: null };
      const json = balancedJson(html, html.indexOf('{', at));
      return { nextData: json ? JSON.parse(json) : null };
    } catch { return { nextData: null }; }
  },
  'json-ld': (html) => {
    const jsonLd = [];
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      // raw control characters inside strings are common in CMS output and invalid JSON: blanked first
      try { const v = JSON.parse(m[1].trim().replace(/[\u0000-\u001f]+/g, ' ')); jsonLd.push(...(Array.isArray(v) ? v : [v])); } catch { /* malformed block: skipped */ }
    }
    return { jsonLd };
  },
  meta: (html) => {
    // the document head only: an inline-svg <title> in the body is not the page title
    const head = /<\/head>/i.test(html) ? html.split(/<\/head>/i)[0] : html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
    const meta = {};
    for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
      // the closing quote is the opening one: an apostrophe inside a double-quoted value is text
      const key = m[0].match(/\b(?:name|property)=(["'])(.*?)\1/i);
      const val = m[0].match(/\bcontent=(["'])(.*?)\1/i);
      if (key && val && !(key[2] in meta)) meta[key[2]] = decodeAttr(val[2]);
    }
    const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return { meta, title: t ? decodeAttr(t[1].trim()) : null };
  },
};

/** params.source for one page: the chosen adapters (meta always, unless none) + the external record. */
export function extractSource(html, mode = 'auto', external = null) {
  const names = mode === 'none' ? [] : mode === 'auto' ? ['next-data', 'json-ld', 'meta'] : [mode, 'meta'];
  const out = { nextData: null, jsonLd: [], meta: {}, title: null, external };
  for (const n of names) Object.assign(out, SOURCE_ADAPTERS[n](html));
  return out;
}

/** The --source-json entry for a page: keyed by slug, URL or URL path; else the whole document. */
export function externalFor(doc, slug, url) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc ?? null;
  let path = null; try { path = new URL(url).pathname; } catch { /* no URL */ }
  for (const k of [slug, url, path, path && path.replace(/\/$/, '')]) if (k && k in doc) return doc[k];
  return doc;
}

/** `Cards (news, dark)` → `cards news dark`; `Section Metadata` → `section-metadata`. */
export function blockClass(name) {
  const m = String(name).trim().match(/^([^(]*?)\s*(?:\(([^)]*)\))?$/);
  const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const variants = m && m[2] ? m[2].split(',').map(slug).filter(Boolean) : [];
  return [slug(m ? m[1] : name), ...variants].join(' ');
}

export function sanitizePath(p) {
  const clean = String(p || '/').toLowerCase().replace(/\.html?$/, '').replace(/[^a-z0-9/._-]+/g, '-').replace(/-+/g, '-').replace(/\/+$/, '');
  return clean && clean !== '/' ? (clean.startsWith('/') ? clean : `/${clean}`) : '/index';
}

const globRe = (g) => new RegExp(`^${g.replace(/\/+$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]+').replace(/\u0000/g, '.*')}/?$`);
const pathOf = (url) => { try { return new URL(url).pathname; } catch { return url; } };

/** The template a URL belongs to: an exact `urls` match first, then the first `patterns` glob. */
export function matchTemplate(templates, url) {
  const p = pathOf(url).replace(/\/+$/, '') || '/';
  const exact = templates.find((t) => (t.urls || []).some((u) => (pathOf(u).replace(/\/+$/, '') || '/') === p));
  return exact || templates.find((t) => (t.patterns || []).some((g) => globRe(g).test(p))) || null;
}

/** Match key for text: entities already decoded; quotes, dashes, ellipsis, nbsp and case folded. */
export const norm = (s) => String(s || '').replace(/[\u00a0\u2009\u200b\u202f]/g, ' ').replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"')
  .replace(/…/g, '...').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

/** Image key: the last path segment without extension (a `url=` query wins: image proxies). */
export function imageKey(src) {
  if (!src || /^data:/i.test(src)) return null;
  let s = src;
  try { const u = new URL(src, 'https://x.invalid'); const inner = u.searchParams.get('url'); s = inner ? decodeURIComponent(inner) : u.pathname; } catch { /* keep raw */ }
  const seg = s.split('?')[0].replace(/\/+$/, '').split('/').pop() || '';
  return seg.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase() || null;
}

/** Href key: same-site → path (no query, no trailing slash); other hosts → host + path. */
export function hrefKey(href, pageUrl) {
  if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return null;
  try {
    const base = new URL(pageUrl);
    const u = new URL(href, base);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return (u.host === base.host ? path : `${u.host}${path}`).toLowerCase();
  } catch { return null; }
}

/**
 * Content-count acceptance (pure): src = { headings[], text[], ctas[{label, href}], images[] } as
 * keys, each item { key, declared }; doc = { text (normalised full text), hrefs Set, images Set }.
 * Returns { counts: {role: [src, found]}, missing: [{role, key}], declared: n }.
 */
export function checkCoverage(src, doc) {
  const counts = {}; const missing = []; let declared = 0;
  const has = (role, item) => {
    if (role === 'images') return doc.images.has(item.key);
    if (role === 'ctas') return (!item.label || doc.text.includes(item.label)) && (!item.href || doc.hrefs.has(item.href));
    return doc.text.includes(item.key);
  };
  for (const role of ['headings', 'text', 'ctas', 'images']) {
    const items = src[role] || [];
    let found = 0;
    for (const it of items) {
      if (has(role, it)) { found += 1; continue; }
      if (it.declared) { declared += 1; continue; }
      missing.push({ role, key: role === 'ctas' ? `${it.label || '(no label)'} → ${it.href || '(no href)'}` : it.key });
    }
    counts[role] = [items.length, found];
  }
  return { counts, missing, declared };
}

/**
 * Structural compare of two document outlines (pure). An outline is [{ blocks: [{name, rows, cols}],
 * texts: string[], images: n, links: n }] per section. Returns the difference lines (empty = same).
 */
export function diffOutlines(got, want) {
  const out = [];
  if (got.length !== want.length) out.push(`sections ${got.length} ≠ ${want.length}`);
  for (let i = 0; i < Math.max(got.length, want.length); i += 1) {
    const g = got[i]; const w = want[i]; const at = `section ${i + 1}`;
    if (!g || !w) { out.push(`${at}: only in ${g ? 'import' : 'reference'} (${(g || w).blocks.map((b) => b.name).join(', ') || 'default content'})`); continue; }
    const shape = (s) => s.blocks.map((b) => `${b.name} ${b.rows}×${b.cols}`).join(' | ') || '—';
    if (shape(g) !== shape(w)) out.push(`${at}: blocks [${shape(g)}] ≠ [${shape(w)}]`);
    const gs = new Set(g.texts); const ws = new Set(w.texts);
    const lack = [...ws].filter((t) => !gs.has(t)); const extra = [...gs].filter((t) => !ws.has(t));
    const cut = (t) => (t.length > 70 ? `${t.slice(0, 67)}…` : t);
    if (lack.length) out.push(`${at}: text missing ${lack.length}: ${lack.slice(0, 3).map((t) => `"${cut(t)}"`).join(', ')}`);
    if (extra.length) out.push(`${at}: text extra ${extra.length}: ${extra.slice(0, 3).map((t) => `"${cut(t)}"`).join(', ')}`);
    if (g.images !== w.images) out.push(`${at}: images ${g.images} ≠ ${w.images}`);
    if (g.links !== w.links) out.push(`${at}: links ${g.links} ≠ ${w.links}`);
  }
  return out;
}

// ---- DOM parts (linkedom) -----------------------------------------------------------------------

/** linkedom's parseHTML, from this script's folder or the project (cwd) — never bundled. */
export async function loadDom() {
  try { return (await import('linkedom')).parseHTML; } catch { /* try the project */ }
  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    return (await import(pathToFileURL(req.resolve('linkedom')).href)).parseHTML;
  } catch (e) {
    throw new Error(`linkedom is not resolvable from ${process.cwd()} (${e.code || e.message}) — add it to the project devDependencies: npm i -D linkedom`);
  }
}

/** The WebImporter global the AEM importer provides, reduced to what parsers and transformers call. */
export function makeWebImporter(log = { removed: [] }) {
  const fill = (td, cell, document) => {
    if (cell === null || cell === undefined) return;
    if (Array.isArray(cell)) { cell.forEach((c) => fill(td, c, document)); return; }
    if (typeof cell === 'string' || typeof cell === 'number') { td.innerHTML += String(cell); return; }
    td.append(cell);
  };
  const createTable = (rows, document) => {
    const table = document.createElement('table');
    const width = Math.max(1, ...rows.map((r) => r.length));
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      row.forEach((cell) => {
        const td = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0 && row.length === 1 && width > 1) td.setAttribute('colspan', String(width));
        fill(td, cell, document); tr.append(td);
      });
      table.append(tr);
    });
    return table;
  };
  const createBlock = (document, { name, variants = [], cells = [] }) => {
    const head = variants.length ? `${name} (${variants.join(', ')})` : name;
    const rows = Array.isArray(cells) ? cells : Object.entries(cells).map(([k, v]) => [k, v]);
    return createTable([[head], ...rows], document);
  };
  const metaOf = (document) => {
    const m = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
    const meta = {};
    const title = document.querySelector('head > title')?.textContent?.trim() || m('meta[property="og:title"]');
    if (title) meta.Title = title;
    const desc = m('meta[name="description"]') || m('meta[property="og:description"]');
    if (desc) meta.Description = desc;
    const image = m('meta[property="og:image"]');
    if (image) { const img = document.createElement('img'); img.setAttribute('src', image); meta.Image = img; }
    return meta;
  };
  return {
    Blocks: { createBlock, getMetadataBlock: (document, meta) => createBlock(document, { name: 'Metadata', cells: meta }) },
    DOMUtils: {
      createTable,
      remove: (root, selectors) => {
        for (const sel of [].concat(selectors)) { log.removed.push(sel); root.querySelectorAll(sel).forEach((el) => el.remove()); }
      },
    },
    rules: {
      createMetadata: (main, document) => { const meta = metaOf(document); main.append(createBlock(document, { name: 'Metadata', cells: meta })); return meta; },
      adjustImageUrls: (main, url) => {
        main.querySelectorAll('img[src]').forEach((img) => { try { img.setAttribute('src', new URL(img.getAttribute('src'), url).href); } catch { /* keep */ } });
      },
      transformBackgroundImages: (main, document) => {
        main.querySelectorAll('[style*="background-image"]').forEach((el) => {
          const m = (el.getAttribute('style') || '').match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
          if (!m) return;
          const img = document.createElement('img'); img.setAttribute('src', m[1]); el.prepend(img);
        });
      },
    },
    FileUtils: { sanitizePath, sanitizeFilename: (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') },
  };
}

/** Importer output (tables + `<hr>` + default content) → the DA document (EDS div-block format). */
export function toDaDocument(container) {
  const sections = [[]];
  const flat = (node) => [...node.childNodes].flatMap((ch) => (ch.nodeType === 1 && ch.tagName === 'DIV' && !ch.attributes.length ? flat(ch) : [ch]));
  const block = (table) => {
    const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
    const name = blockClass(rows[0]?.textContent || 'block');
    const body = rows.slice(1).map((tr) => `<div>${[...tr.children].map((td) => `<div>${td.innerHTML}</div>`).join('')}</div>`).join('');
    return `<div class="${name}">${body}</div>`;
  };
  for (const ch of flat(container)) {
    if (ch.nodeType === 3) { if (ch.textContent.trim()) sections.at(-1).push(`<p>${ch.textContent.trim()}</p>`); continue; }
    if (ch.nodeType !== 1) continue;
    if (ch.tagName === 'HR') { sections.push([]); continue; }
    sections.at(-1).push(ch.tagName === 'TABLE' ? block(ch) : ch.outerHTML);
  }
  const main = sections.filter((s) => s.length).map((s) => `<div>${s.join('')}</div>`).join('');
  return `<body><header></header><main>${main}</main><footer></footer></body>\n`;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'HEAD']);
const hidden = (el) => el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || /display:\s*none/i.test(el.getAttribute('style') || '');

/** Source-side items under root: headings, text runs (outside headings and plain links), CTAs, images. */
export function inventoryOf(root, pageUrl, declaredEls = new Set(), declaredTexts = []) {
  const inv = { headings: [], text: [], ctas: [], images: [] };
  const isDeclared = (el, key) => {
    for (let n = el; n; n = n.parentElement) if (declaredEls.has(n)) return true;
    return Boolean(key) && declaredTexts.some((t) => key.includes(t));
  };
  const walk = (el, inHeading, inLink) => {
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3) {
        const key = norm(ch.textContent);
        if (key.length >= 2 && !inHeading && !inLink) inv.text.push({ key, declared: isDeclared(el, key) });
        continue;
      }
      if (ch.nodeType !== 1 || SKIP.has(ch.tagName.toUpperCase()) || hidden(ch)) continue;
      const tag = ch.tagName.toUpperCase();
      if (/^H[1-6]$/.test(tag)) { const key = norm(ch.textContent); if (key) inv.headings.push({ key, declared: isDeclared(ch, key) }); }
      // a card-wrapping anchor (block content inside) counts its href; its texts count as text runs
      const card = tag === 'A' && Boolean(ch.querySelector('h1,h2,h3,h4,h5,h6,p,div,li,img,figure'));
      if (tag === 'A') {
        const label = card ? null : norm(ch.textContent) || null; const href = hrefKey(ch.getAttribute('href'), pageUrl);
        if (label || href) inv.ctas.push({ label, href, declared: isDeclared(ch, label) });
      }
      if (tag === 'IMG' && !(ch.getAttribute('width') === '1' && ch.getAttribute('height') === '1')) {
        const key = imageKey(ch.getAttribute('src') || ch.getAttribute('data-src'));
        if (key) inv.images.push({ key, declared: isDeclared(ch, null) });
      }
      walk(ch, inHeading || /^H[1-6]$/.test(tag), inLink || (tag === 'A' && !card));
    }
  };
  walk(root, false, false);
  return inv;
}

/** Document side of the count: its normalised text, href keys and image keys — plus its fragments' (#143). */
export function docFacts(document, pageUrl, fragments = []) {
  const roots = [document, ...fragments].map((d) => d.querySelector('main') || d.body);
  return {
    text: roots.map((m) => norm(m.textContent)).join(' \u0000 '),
    hrefs: new Set(roots.flatMap((m) => [...m.querySelectorAll('a[href]')].map((a) => hrefKey(a.getAttribute('href'), pageUrl))).filter(Boolean)),
    images: new Set(roots.flatMap((m) => [...m.querySelectorAll('img')].map((i) => imageKey(i.getAttribute('src')))).filter(Boolean)),
  };
}

/** The fragment paths a DA document uses: its `/fragments/` links (same-site or root-relative) + the injected ones. */
export function fragmentPaths(html, injected = []) {
  const linked = [...String(html).matchAll(/href="(?:https?:\/\/[^"/]+)?(\/fragments\/[^"#?]+)"/g)].map((m) => m[1].replace(/\.html$/, '').replace(/\/+$/, ''));
  return [...new Set([...linked, ...[].concat(injected || [])])];
}

const ATOM = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,pre,td,th';
/** A DA document's outline for diffOutlines: per section its blocks, text atoms, images, links. */
export function outlineOf(document) {
  const main = document.querySelector('main') || document.body;
  return [...main.children].filter((s) => s.tagName === 'DIV').map((sec) => {
    const blocks = [...sec.children].filter((c) => c.tagName === 'DIV' && c.className).map((b) => ({
      name: b.className.trim(), rows: b.children.length, cols: Math.max(0, ...[...b.children].map((r) => r.children.length)),
    }));
    const texts = new Set();
    sec.querySelectorAll(ATOM).forEach((el) => { if (!el.querySelector(ATOM)) { const t = norm(el.textContent); if (t) texts.add(t); } });
    sec.querySelectorAll('div').forEach((cell) => {
      if (cell.children.length && [...cell.children].some((c) => c.tagName === 'DIV')) return;
      if (cell.querySelector(ATOM)) return;
      const t = norm(cell.textContent); if (t) texts.add(t);
    });
    return { blocks, texts: [...texts], images: sec.querySelectorAll('img').length, links: sec.querySelectorAll('a[href]').length };
  });
}

// ---- the run ------------------------------------------------------------------------------------

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

export function loadTemplates(importerDir) {
  const f = join(importerDir, 'page-templates.json');
  if (!existsSync(f)) throw new Error(`${f} not found — the template registry of the AEM importer convention`);
  const j = readJson(f);
  const list = Array.isArray(j) ? j : j.templates;
  if (!Array.isArray(list)) throw new Error(`${f}: expected { templates: [ … ] }`);
  return list.map((t) => ({ ...t, id: t.id || t.name }));
}

async function importOne({ parseHTML, mod, tpl, page, o, external }) {
  const capFile = join(o.current, 'pages', `${page.slug}.html`);
  let html;
  if (o.fetch || !existsSync(capFile)) {
    if (!o.fetch) throw new Error(`no capture ${capFile} (pass --fetch to build the DOM from ${page.url})`);
    const r = await fetch(page.url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`fetch ${page.url} → HTTP ${r.status}`);
    html = await r.text();
  } else html = readFileSync(capFile, 'utf8');
  const capJson = join(o.current, 'pages', `${page.slug}.json`);
  const source = extractSource(html, o.source, externalFor(external, page.slug, page.url));
  const log = { removed: [] };
  globalThis.WebImporter = makeWebImporter(log);
  const { document } = parseHTML(html);
  const params = { originalURL: page.url, slug: page.slug, template: tpl.id, capture: existsSync(capJson) ? readJson(capJson) : null, source };
  const payload = { document, url: page.url, html, params };
  let results;
  if (typeof mod.transform === 'function') results = await mod.transform(payload);
  else if (typeof mod.transformDOM === 'function') {
    const element = await mod.transformDOM(payload);
    const path = typeof mod.generateDocumentPath === 'function' ? mod.generateDocumentPath(payload) : new URL(page.url).pathname;
    results = [{ element, path }];
  } else throw new Error('the import script exports neither transform nor transformDOM');
  results = [].concat(results).filter(Boolean);
  if (!results.length || !results[0].element) throw new Error('transform returned no element');
  const all = results.map((r) => ({ path: sanitizePath(r.path || new URL(page.url).pathname), html: toDaDocument(r.element), report: r.report || {} }));
  const isFragment = (d) => d.path.startsWith('/fragments/');
  const docs = [...all.filter((d) => !isFragment(d)), ...all.filter(isFragment)];
  if (isFragment(docs[0])) throw new Error('transform returned only fragment documents');
  // acceptance: the pristine capture, scoped, against the main document and the fragments it uses
  const pristine = parseHTML(html).document;
  const scope = docs[0].report.scope || tpl.scope;
  const root = (scope && pristine.querySelector(scope)) || pristine.querySelector('main') || pristine.body;
  const devs = [].concat(docs[0].report.deviations || []);
  const declaredEls = new Set();
  for (const sel of [...log.removed, ...devs.filter((d) => d.selector).map((d) => d.selector)]) {
    try { pristine.querySelectorAll(sel).forEach((el) => declaredEls.add(el)); } catch { /* selector linkedom cannot parse: nothing declared */ }
  }
  const declaredTexts = devs.filter((d) => d.text).map((d) => norm(d.text));
  const src = inventoryOf(root, page.url, declaredEls, declaredTexts);
  const frags = []; const fragMissing = [];
  for (const p of fragmentPaths(docs[0].html, docs[0].report.fragments)) {
    const own = docs.find((d) => d.path === p);
    const file = join(o.out, `${p}.html`);
    const fhtml = own ? own.html : (o.written.get(p)?.html ?? (existsSync(file) ? readFileSync(file, 'utf8') : null));
    if (fhtml == null) fragMissing.push({ role: 'fragment', key: `${p} — no fragment document (emit it or create ${file})` });
    else frags.push(parseHTML(fhtml).document);
  }
  for (const d of docs.filter(isFragment)) {
    const prev = o.written.get(d.path);
    if (prev && prev.html !== d.html) fragMissing.push({ role: 'fragment', key: `${d.path} differs from the copy ${prev.slug} emitted — not a verbatim part` });
  }
  const cov = checkCoverage(src, docFacts(parseHTML(docs[0].html).document, page.url, frags));
  cov.missing.push(...fragMissing);
  cov.fragments = frags.length;
  return { docs, cov, deviations: devs };
}

export async function main(argv) {
  const o = parseArgs(argv);
  const parseHTML = await loadDom();
  const templates = loadTemplates(o.importer);
  const state = existsSync(o.state) ? readJson(o.state) : { pages: [] };
  const pages = Array.isArray(state.pages) ? state.pages : Object.values(state.pages || {});
  if (o.list) {
    for (const t of templates) {
      const n = pages.filter((p) => matchTemplate([t], p.url) && matchTemplate(templates, p.url) === t).length;
      console.log(`${t.id}  ${n} state pages  ${t.script || `import-${t.id}.js`}${existsSync(join(o.importer, t.script || `import-${t.id}.js`)) ? '' : '  (script missing)'}`);
    }
    return 0;
  }
  const id = o.template || o['all-of'];
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) throw new Error(`template "${id}" is not in ${join(o.importer, 'page-templates.json')} (${templates.map((t) => t.id).join(', ')})`);
  let todo;
  if (o['all-of']) todo = pages.filter((p) => matchTemplate(templates, p.url) === tpl);
  else {
    todo = (o.slugs ? o.slugs.split(',').filter(Boolean) : []).map((s) => {
      const p = pages.find((x) => x.slug === s);
      if (!p) throw new Error(`slug "${s}" is not in ${o.state}`);
      return p;
    });
    for (const u of o.urls) todo.push(pages.find((x) => x.url === u) || { slug: (new URL(u).pathname.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'index'), url: u });
  }
  if (!todo.length) throw new Error(`no page matches template "${id}"`);
  const script = resolve(o.importer, tpl.script || `import-${tpl.id}.js`);
  if (!existsSync(script)) throw new Error(`${script} not found`);
  globalThis.WebImporter = makeWebImporter();
  const loaded = await import(pathToFileURL(script).href);
  const mod = loaded.default || loaded;
  const external = o['source-json'] ? readJson(o['source-json']) : null;
  const max = Number(o['max-lines']);
  const tally = { imported: 0, failed: 0, errors: 0, same: 0, differ: 0 }; const rows = [];
  o.written = new Map();
  for (const page of todo) {
    try {
      const { docs, cov } = await importOne({ parseHTML, mod, tpl, page, o, external });
      const files = docs.map((d) => join(o.out, `${d.path}.html`));
      docs.forEach((d, i) => {
        const fragment = d.path.startsWith('/fragments/');
        if (fragment && o.written.has(d.path)) return; // written once per run (a differing copy failed the count)
        if (fragment) o.written.set(d.path, { html: d.html, slug: page.slug });
        if (!o['dry-run']) { mkdirSync(dirname(files[i]), { recursive: true }); writeFileSync(files[i], d.html); }
      });
      let cmp = '';
      let diffs = [];
      if (o.compare) {
        const ref = join(o.compare, `${docs[0].path}.html`);
        if (!existsSync(ref)) diffs = [`no reference ${ref}`];
        else diffs = diffOutlines(outlineOf(parseHTML(docs[0].html).document), outlineOf(parseHTML(readFileSync(ref, 'utf8')).document));
        cmp = diffs.length ? `  ≠ ${diffs.length} diffs` : '  = same';
        tally[diffs.length ? 'differ' : 'same'] += 1;
      }
      const c = cov.counts; const fmt = (r) => `${c[r][1]}/${c[r][0]}`;
      const ok = !cov.missing.length;
      tally[ok ? 'imported' : 'failed'] += 1;
      console.log(`${ok ? 'ok   ' : 'FAIL '} ${page.slug} → ${files[0]}  h ${fmt('headings')} · text ${fmt('text')} · cta ${fmt('ctas')} · img ${fmt('images')}${cov.declared ? `  [declared ${cov.declared}]` : ''}${cov.fragments ? `  [fragments ${cov.fragments}]` : ''}${cmp}`);
      cov.missing.slice(0, max).forEach((m) => console.log(`        missing ${m.role}: ${m.key.length > 90 ? `${m.key.slice(0, 87)}…` : m.key}`));
      if (cov.missing.length > max) console.log(`        … ${cov.missing.length - max} more missing`);
      diffs.slice(0, max).forEach((d) => console.log(`        ${d}`));
      rows.push({ slug: page.slug, files, ok, counts: c, missing: cov.missing, declared: cov.declared, diffs });
    } catch (e) {
      tally.errors += 1; rows.push({ slug: page.slug, error: e.message });
      console.log(`ERROR ${page.slug}: ${String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`);
    }
  }
  if (o.json) { mkdirSync(dirname(o.json), { recursive: true }); writeFileSync(o.json, `${JSON.stringify(rows, null, 2)}\n`); }
  console.log(`import-run ${tpl.id}: imported ${tally.imported}, failed ${tally.failed}, errors ${tally.errors}${o.compare ? `, compared ${tally.same} same / ${tally.differ} differ` : ''} → ${o['dry-run'] ? '(dry run)' : o.out}`);
  if (tally.failed || tally.errors) return 2;
  return tally.differ ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(help()); process.exit(0); }
  main(argv).then((code) => process.exit(code), (e) => { console.error(`import-run: ${e.message}`); process.exit(1); });
}
