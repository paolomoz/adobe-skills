#!/usr/bin/env node
/**
 * rollout/template-parts.mjs — the parts a template's documents carry verbatim on many pages (#143):
 * candidates to author ONCE (a fragment or template injection, deploy SKILL.md § The ENCODE
 * contract), with the pages, share, size and a suggested home.
 *
 * Input: DA documents (the delivered `content/` tree or the importer's output — a capture goes
 * through the importer first). Groups: `--templates <page-templates.json>` (each template's `urls`
 * → `<content><path>.html`), `--by-meta <key>` (every document under --content grouped by that
 * metadata row, e.g. Template), or `<file|dir>…` as one group named by `--template`.
 * Parts per document: each section, each block in it, each row of a block (a keyed row's slot is
 * `<block>/<key>`, the key a short plain first cell) and each run of default content between blocks.
 * Normalised before hashing: whitespace and entities, an image by its file name (per-page media
 * scopes fold), the page's own path replaced by `{page}`, every `--slot <regex>` match
 * replaced by `{slot}` (declared per-page slots: a tracking parameter, a date).
 *   template part  the same normalised part on ≥ --threshold of the group's pages (default 0.5,
 *                  at least 2) and ≥ --min-bytes (default 80); a part nested in another candidate
 *                  with the same pages is not repeated. Home: `inject` when it sits on every page at
 *                  the same position (fixed template chrome → template code adds it), else
 *                  `reference` (a fragment link where each page places it); `/fragments/<group>/<part>`.
 *   entity part    below the threshold, but each version sits only on pages sharing one value of a
 *                  metadata row (an author card per Author): `/fragments/<key>/<value>`, injected
 *                  from that metadata.
 *   shared         a candidate whose normalised form is also a candidate of another group:
 *                  `/fragments/shared/<part>`.
 * Per group: median document bytes now and with the candidates authored once (references cost 0).
 * Fragment links already in the documents are listed as parts already authored once.
 *
 * Usage: node template-parts.mjs --templates tools/importer/page-templates.json [--content content]
 *          | --by-meta <key> [--content content] | <file|dir>… --template <name>
 *          [--threshold 0.5] [--min-bytes 80] [--slot <regex>]… [--group <name>] [--json <file>]
 *          [--check] [--max-rows 30]
 * Prints a table per group (part · level · pages · share · bytes · versions · home), the entity
 * parts, the document bytes line, then `template-parts: N groups, N template parts, N entity parts,
 * N shared; median document A → B KB`. Exit 0 after a run (2 with --check when a candidate exists),
 * 1 usage / no documents.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

// --help before any import with side effects (block-audit answers --help itself on load).
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const header = src.match(/\/\*\*[\s\S]*?\*\//);
  console.log(header ? header[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim() : 'no usage header');
  process.exit(0);
}
const { topChildren } = await import('./block-audit.mjs');
// the importer's own template matching (sibling skill: plugin tree, else the project copy's layout)
const IMPORT_RUN = ['../../migrate/scripts/import-run.mjs', '../migrate/import-run.mjs'].map((p) => new URL(p, import.meta.url)).find((u) => existsSync(u));
if (!IMPORT_RUN) { console.error('template-parts: import-run.mjs not found (../../migrate/scripts/ or ../migrate/) — copy the migrate skill\'s scripts next to these'); process.exit(1); }
const { matchTemplate, loadTemplates } = await import(IMPORT_RUN.href);

// ---- normalisation ------------------------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...' };
export const decode = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/[\u00a0\u2009\u200b\u202f]/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-');
const fileOf = (src) => { const p = String(src).split(/[?#]/)[0].replace(/\/+$/, ''); return p.slice(p.lastIndexOf('/') + 1).toLowerCase(); };
export const textOf = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The comparable form of a part's HTML: images by file name, page self-references and slots masked. */
export function normalise(html, { self = [], slots = [] } = {}) {
  let s = String(html)
    .replace(/<(img|source)\b[^>]*?\b(src|srcset)="([^"]*)"[^>]*>/gi, (_, t, a, v) => `<img ${fileOf(v.split(/\s/)[0])}>`)
    .replace(/<\/?picture[^>]*>/gi, '')
    .replace(/\s(?:class|id|style|data-[\w-]+)="[^"]*"/gi, (m) => (/^\sclass=/i.test(m) ? m : ''));
  s = decode(s).replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  for (const v of self.filter((x) => x && x.length > 3)) s = s.replace(new RegExp(esc(decode(v)), 'gi'), '{page}');
  for (const re of slots) s = s.replace(re, '{slot}');
  return s;
}
export const hashOf = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'part';

// ---- documents → parts --------------------------------------------------------------------------
const classOf = (attrs) => { const m = /class="([^"]*)"/i.exec(attrs || ''); return m ? m[1].trim().split(/\s+/).filter(Boolean) : []; };
const outer = (n) => (n.tag === '#text' ? n.inner : `<${n.tag}${n.attrs}>${n.inner}</${n.tag}>`);
const SKIP_BLOCKS = new Set(['metadata', 'section-metadata']);

/** The metadata rows of a document: { key (lower case): text }. */
export function metadataOf(html) {
  const out = {};
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  for (const sec of topChildren(main ? main[1] : html).filter((n) => n.tag === 'div')) {
    for (const b of topChildren(sec.inner).filter((n) => n.tag === 'div' && classOf(n.attrs)[0] === 'metadata')) {
      for (const row of topChildren(b.inner).filter((n) => n.tag === 'div')) {
        const cells = topChildren(row.inner).filter((n) => n.tag === 'div');
        if (cells.length >= 2) out[textOf(cells[0].inner).toLowerCase()] = textOf(cells[1].inner);
      }
    }
  }
  return out;
}

/** A keyed row's key: a first cell of ≤ 3 plain words (no link, image or heading), else null. */
export function rowKey(cells) {
  if (cells.length < 2) return null;
  const c = cells[0].inner;
  if (/<(a|img|picture|h[1-6]|ul|ol)\b/i.test(c)) return null;
  const t = textOf(c);
  return t && t.split(' ').length <= 3 && t.length <= 32 ? t.toLowerCase() : null;
}

/**
 * Every part of one DA document: [{ id, parent, level: section|block|row|content, slot, html,
 * bytes, pos: { index, fromEnd } }] — index/fromEnd among the parent's parts of the same level.
 */
export function partsOf(html) {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  const sections = topChildren(main ? main[1] : html).filter((n) => n.tag === 'div');
  const parts = [];
  const add = (p) => { parts.push({ ...p, id: parts.length, bytes: Buffer.byteLength(p.html) }); return parts.length - 1; };
  sections.forEach((sec, si) => {
    const kids = topChildren(sec.inner);
    const blocks = kids.filter((n) => n.tag === 'div' && classOf(n.attrs).length);
    if (blocks.length && blocks.every((b) => SKIP_BLOCKS.has(classOf(b.attrs)[0]))) return;
    const firstBlock = blocks.map((b) => classOf(b.attrs)[0]).find((c) => !SKIP_BLOCKS.has(c));
    const sid = add({ parent: null, level: 'section', slot: `section:${firstBlock || 'default'}`, html: sec.inner, pos: { index: si, fromEnd: sections.length - 1 - si } });
    const children = []; let run = [];
    const flush = () => { if (run.length) children.push({ kind: 'content', html: run.map(outer).join('') }); run = []; };
    for (const n of kids) {
      const cls = n.tag === 'div' ? classOf(n.attrs) : [];
      if (cls.length) { flush(); if (!SKIP_BLOCKS.has(cls[0])) children.push({ kind: 'block', cls, node: n }); } else run.push(n);
    }
    flush();
    const seen = {};
    children.forEach((ch, ci) => {
      const pos = { index: ci, fromEnd: children.length - 1 - ci };
      if (ch.kind === 'content') { add({ parent: sid, level: 'content', slot: `${firstBlock || 'section'}/content`, html: ch.html, pos }); return; }
      const name = ch.cls.join('.');
      seen[name] = (seen[name] || 0) + 1;
      const bid = add({ parent: sid, level: 'block', slot: seen[name] > 1 ? `${name}#${seen[name]}` : name, html: outer(ch.node), pos });
      const rows = topChildren(ch.node.inner).filter((n) => n.tag === 'div');
      rows.forEach((r, ri) => {
        const cells = topChildren(r.inner).filter((n) => n.tag === 'div');
        const key = rowKey(cells);
        add({ parent: bid, level: 'row', slot: `${ch.cls[0]}/${key || `row${ri + 1}`}`, html: outer(r), pos: { index: ri, fromEnd: rows.length - 1 - ri } });
      });
    });
  });
  return parts;
}

/** True when a part's only content is fragment links (a `fragment` block, a `parts` row, a section of them). */
export function isReference(html) {
  if (!/\/fragments\//.test(html)) return false;
  return textOf(String(html).replace(/<a\b[^>]*href="[^"]*\/fragments\/[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')).replace(/\bparts\b/gi, '').trim() === '';
}

// ---- analysis (pure: docs = [{ page, html }]) -----------------------------------------------------
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const IGNORE_META = new Set(['title', 'description', 'json-ld', 'image', 'og:image', 'robots', 'keywords', 'canonical']);
const partName = (slot) => slug(slot.replace(/#\d+$/, '').replace(/^section:/, 'section-').replace('/', '-'));

/** Parts of every document, normalised and hashed: docs[i].parts[j].{norm, hash}. */
export function prepare(docs, { slots = [] } = {}) {
  return docs.map((d) => {
    const meta = metadataOf(d.html);
    const self = [d.page].filter((p) => p && p !== '/');
    const parts = partsOf(d.html).map((p) => { const norm = normalise(p.html, { self, slots }); return { ...p, norm, hash: hashOf(`${p.level}|${norm}`) }; });
    return { ...d, meta, parts, bytes: Buffer.byteLength(d.html) };
  });
}

/**
 * One group's analysis over prepared docs: { pages, need, candidates[], entities[], bytes, fragmentRefs }.
 * A candidate: { hash, name, level, slot, pages[], share, bytes, text, versions, home, path }.
 */
export function analyse(group, docs, { threshold = 0.5, minBytes = 80 } = {}) {
  const n = docs.length;
  const need = Math.max(2, Math.ceil(threshold * n));
  const byHash = new Map();
  docs.forEach((d, di) => d.parts.forEach((p) => {
    if (!byHash.has(p.hash)) byHash.set(p.hash, { hash: p.hash, level: p.level, slot: p.slot, occ: [], pages: new Set() });
    const h = byHash.get(p.hash); h.occ.push({ di, p }); h.pages.add(d.page);
  }));
  // a reference to a part already authored once (a fragment link, a `parts` row) is not a part again
  const big = (h) => median(h.occ.map((o) => o.p.bytes)) >= minBytes && !isReference(h.occ[0].p.html);
  const nestedIn = (h, set) => h.occ.every(({ di, p }) => {
    for (let q = p.parent; q != null; q = docs[di].parts[q].parent) if (set.has(docs[di].parts[q].hash)) return true;
    return false;
  });
  const versionsOf = (slot) => new Set(docs.flatMap((d) => d.parts.filter((p) => p.slot === slot).map((p) => p.hash))).size;
  const describe = (h) => ({
    hash: h.hash, name: partName(h.slot), level: h.level, slot: h.slot, pages: [...h.pages].sort(), share: +(h.pages.size / n).toFixed(2),
    bytes: Math.round(median(h.occ.map((o) => o.p.bytes))), text: textOf(h.occ[0].p.html).slice(0, 120), versions: versionsOf(h.slot),
  });
  const keys = [...new Set(docs.flatMap((d) => Object.keys(d.meta)))].filter((k) => !IGNORE_META.has(k)
    && new Set(docs.map((d) => d.meta[k] || '')).size > 1);
  const docOf = new Map(docs.map((d) => [d.page, d]));
  /** The metadata row whose one value every page of h shares (an entity key), else undefined. */
  const entityKey = (h) => {
    const ds = [...h.pages].map((pg) => docOf.get(pg));
    return keys.find((k) => ds[0].meta[k] && ds.every((d) => d.meta[k] === ds[0].meta[k]));
  };
  // a version on part of the pages that one metadata value explains is an entity part, not a template part
  const cand = [...byHash.values()].filter((h) => h.pages.size >= need && big(h)
    && !(h.pages.size < n && versionsOf(h.slot) > 1 && entityKey(h)));
  const candSet = new Set(cand.map((h) => h.hash));
  const candidates = cand.filter((h) => !nestedIn(h, candSet)).map((h) => {
    const c = describe(h);
    const fixed = h.pages.size === n && (new Set(h.occ.map((o) => o.p.pos.index)).size === 1 || new Set(h.occ.map((o) => o.p.pos.fromEnd)).size === 1);
    return { ...c, home: fixed ? 'inject' : 'reference', path: `/fragments/${slug(group)}/${c.name}` };
  }).sort((a, b) => b.pages.length - a.pages.length || b.bytes - a.bytes);
  // entity parts: repeated versions whose pages share one value of a metadata row (≥ 2 values per family)
  const fam = new Map();
  for (const h of byHash.values()) {
    if (candSet.has(h.hash) || h.pages.size < 2 || !big(h) || nestedIn(h, candSet)) continue;
    const key = entityKey(h);
    if (!key) continue;
    const id = `${h.slot}|${key}`;
    if (!fam.has(id)) fam.set(id, { slot: h.slot, key, level: h.level, hashes: [], values: new Set(), pages: new Set(), bytes: [], occ: [] });
    const f = fam.get(id);
    f.hashes.push(h.hash); f.values.add(docOf.get([...h.pages][0]).meta[key]); h.pages.forEach((p) => f.pages.add(p));
    f.bytes.push(...h.occ.map((o) => o.p.bytes)); f.occ.push(...h.occ);
  }
  // a family holding a template part descends to its rows; an inner family under a kept one is not repeated
  const holdsCandidate = (f) => f.occ.some(({ di, p }) => docs[di].parts.some((q) => {
    for (let a = q.parent; a != null; a = docs[di].parts[a].parent) if (a === p.id) return candSet.has(q.hash);
    return false;
  }));
  const kept = [...fam.values()].filter((f) => f.values.size >= 2 && !holdsCandidate(f));
  const famHashes = new Set(kept.flatMap((f) => f.hashes));
  const entities = kept.filter((f) => !f.hashes.every((x) => nestedIn(byHash.get(x), famHashes))).map((f) => {
    // pages of an entity value carrying the slot with another version = conflicts (the part is not keyed by it alone)
    const conflicts = docs.filter((d) => f.values.has(d.meta[f.key]) && d.parts.some((p) => p.slot === f.slot) && !d.parts.some((p) => f.hashes.includes(p.hash))).length;
    return {
      name: partName(f.slot), level: f.level, slot: f.slot, key: f.key, entities: f.values.size, values: [...f.values].sort(), hashes: f.hashes,
      pages: [...f.pages].sort(), share: +(f.pages.size / n).toFixed(2), bytes: Math.round(median(f.bytes)), conflicts,
      home: 'inject', path: `/fragments/${slug(f.key)}/<${slug(f.key)}>`,
    };
  }).sort((a, b) => b.pages.length - a.pages.length);
  // document bytes: now, and with every candidate / entity occurrence authored once (maximal parts only)
  const once = new Set([...candidates.map((c) => c.hash), ...entities.flatMap((e) => e.hashes)]);
  const after = docs.map((d) => {
    const covered = (p) => { for (let q = p.parent; q != null; q = d.parts[q].parent) if (once.has(d.parts[q].hash)) return true; return false; };
    return d.bytes - d.parts.filter((p) => once.has(p.hash) && !covered(p)).reduce((s, p) => s + p.bytes, 0);
  });
  const fragmentRefs = {};
  docs.forEach((d) => [...d.html.matchAll(/href="(?:https?:\/\/[^"/]+)?(\/fragments\/[^"#?]+)"/g)].forEach((m) => { (fragmentRefs[m[1]] ||= new Set()).add(d.page); }));
  return {
    group, pages: n, need, candidates, entities,
    bytes: { before: Math.round(median(docs.map((d) => d.bytes))), after: Math.round(median(after)) },
    fragmentRefs: Object.fromEntries(Object.entries(fragmentRefs).map(([k, v]) => [k, v.size])),
  };
}

/** Parts that are candidates (template or entity) in ≥ 2 groups: [{ hash, name, groups[] }]; marks them shared. */
export function crossGroups(results) {
  const seen = new Map();
  for (const r of results) {
    for (const c of r.candidates) { if (!seen.has(c.hash)) seen.set(c.hash, { hash: c.hash, name: c.name, groups: [] }); seen.get(c.hash).groups.push(r.group); }
  }
  const shared = [...seen.values()].filter((s) => s.groups.length > 1);
  for (const r of results) {
    for (const c of r.candidates) {
      const s = shared.find((x) => x.hash === c.hash);
      if (s) { c.shared = s.groups; c.path = `/fragments/shared/${c.name}`; }
    }
  }
  return shared;
}

// ---- CLI ------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const o = { content: 'content', threshold: 0.5, minBytes: 80, slots: [], files: [], maxRows: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const v = () => { i += 1; if (argv[i] == null) throw new Error(`${a} needs a value`); return argv[i]; };
    if (a === '--templates') o.templates = v();
    else if (a === '--content') o.content = v();
    else if (a === '--by-meta') o.byMeta = v().toLowerCase();
    else if (a === '--template') o.template = v();
    else if (a === '--group') o.group = v();
    else if (a === '--threshold') o.threshold = Number(v());
    else if (a === '--min-bytes') o.minBytes = Number(v());
    else if (a === '--slot') o.slots.push(new RegExp(v(), 'gi'));
    else if (a === '--json') o.json = v();
    else if (a === '--max-rows') o.maxRows = Number(v());
    else if (a === '--check') o.check = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.files.push(a);
  }
  if (!(o.threshold > 0 && o.threshold <= 1)) throw new Error('--threshold is a share in (0, 1]');
  if (!o.templates && !o.byMeta && !o.files.length) throw new Error('pass --templates <page-templates.json>, --by-meta <key> or <file|dir>…');
  return o;
}

const htmlFiles = (p, skipFragments = true) => {
  if (!existsSync(p)) return [];
  if (!statSync(p).isDirectory()) return p.endsWith('.html') ? [p] : [];
  return readdirSync(p).flatMap((f) => (skipFragments && f === 'fragments' ? [] : htmlFiles(join(p, f), skipFragments)));
};
const pageOf = (file, root) => `/${relative(root, file).replace(/\\/g, '/').replace(/\.html$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/+$/, '') || '/';

/** Groups → [{ group, docs: [{ page, file, html }], missing[] }]. */
export function loadGroups(o) {
  const read = (file, root) => ({ page: pageOf(file, root), file, html: readFileSync(file, 'utf8') });
  if (o.templates) {
    const templates = loadTemplates(dirname(o.templates));
    const all = htmlFiles(o.content).map((f) => ({ f, page: pageOf(f, o.content) }));
    return templates.map((t) => {
      const docs = all.filter((x) => matchTemplate(templates, x.page) === t).map((x) => read(x.f, o.content));
      const have = new Set(docs.map((d) => d.page));
      const missing = (t.urls || []).map((u) => new URL(u).pathname.replace(/\/+$/, '') || '/').filter((p) => !have.has(p));
      return { group: t.id, docs, missing };
    });
  }
  if (o.byMeta) {
    const by = new Map();
    for (const f of htmlFiles(o.content)) {
      const d = read(f, o.content); const v = metadataOf(d.html)[o.byMeta];
      if (!v) continue;
      if (!by.has(v)) by.set(v, []); by.get(v).push(d);
    }
    return [...by].map(([group, docs]) => ({ group, docs, missing: [] }));
  }
  const docs = o.files.flatMap((p) => htmlFiles(p, false).map((f) => read(f, statSync(p).isDirectory() ? p : dirname(p))));
  return [{ group: o.template || 'documents', docs, missing: [] }];
}

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const pad = (s, w) => String(s).padEnd(w).slice(0, Math.max(w, String(s).length));

export function render(r, maxRows = 30) {
  const out = [`${r.group}: ${r.pages} pages, part on ≥ ${r.need} pages`];
  if (r.missing?.length) out.push(`  (no document for ${r.missing.length}: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? ', …' : ''})`);
  if (r.candidates.length) out.push(`  ${pad('part', 34)} ${pad('level', 7)} ${pad('pages', 7)} ${pad('share', 5)} ${pad('bytes', 6)} ${pad('vers', 4)} home`);
  for (const c of r.candidates.slice(0, maxRows)) {
    out.push(`  ${pad(c.slot, 34)} ${pad(c.level, 7)} ${pad(`${c.pages.length}/${r.pages}`, 7)} ${pad(c.share.toFixed(2), 5)} ${pad(c.bytes, 6)} ${pad(c.versions, 4)} ${c.shared ? 'reference' : c.home} ${c.path}${c.shared ? `  (shared: ${c.shared.join(', ')})` : ''}`);
    out.push(`      “${c.text.slice(0, 96)}”`);
  }
  if (r.candidates.length > maxRows) out.push(`  … ${r.candidates.length - maxRows} more`);
  for (const e of r.entities.slice(0, maxRows)) {
    out.push(`  entity ${pad(e.slot, 27)} ${pad(e.level, 7)} ${pad(`${e.pages.length}/${r.pages}`, 7)} ${pad(e.share.toFixed(2), 5)} ${pad(e.bytes, 6)} by ${e.key}: ${e.entities} values${e.conflicts ? `, ${e.conflicts} conflicting pages` : ''} → ${e.home} ${e.path}`);
  }
  const refs = Object.entries(r.fragmentRefs);
  if (refs.length) out.push(`  already authored once: ${refs.map(([k, v]) => `${k} (${v})`).join(', ')}`);
  out.push(`  document bytes median ${kb(r.bytes.before)} → ${kb(r.bytes.after)} with the parts above authored once`);
  return out.join('\n');
}

export function main(argv) {
  const o = parseArgs(argv);
  const loaded = loadGroups(o);
  let groups = loaded.filter((g) => g.docs.length >= 2);
  if (o.group) groups = groups.filter((g) => g.group === o.group);
  if (!groups.length) throw new Error('no group with 2 or more documents found');
  const single = loaded.filter((g) => g.docs.length === 1).length;
  if (single && !o.group) console.log(`(${single} single-document groups skipped)\n`);
  const results = groups.map((g) => ({ ...analyse(g.group, prepare(g.docs, o), o), missing: g.missing }));
  const shared = crossGroups(results);
  results.forEach((r) => console.log(`${render(r, o.maxRows)}\n`));
  if (shared.length) console.log(`shared across groups: ${shared.map((s) => `${s.name} (${s.groups.join(', ')})`).join('; ')}\n`);
  const nt = results.reduce((s, r) => s + r.candidates.length, 0); const ne = results.reduce((s, r) => s + r.entities.length, 0);
  const before = median(results.flatMap((r) => r.bytes.before)); const after = median(results.flatMap((r) => r.bytes.after));
  console.log(`template-parts: ${results.length} groups, ${nt} template parts, ${ne} entity parts, ${shared.length} shared; median document ${kb(before)} → ${kb(after)}`);
  if (o.json) { mkdirSync(dirname(o.json), { recursive: true }); writeFileSync(o.json, `${JSON.stringify({ threshold: o.threshold, minBytes: o.minBytes, groups: results, shared }, null, 2)}\n`); }
  return o.check && nt + ne ? 2 : 0;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`template-parts: ${e.message}`); process.exit(1); }
}
