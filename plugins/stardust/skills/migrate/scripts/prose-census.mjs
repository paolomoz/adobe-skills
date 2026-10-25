#!/usr/bin/env node
/**
 * migrate/prose-census.mjs — the prose census of a template's authored bodies, over every capture, before
 * cloning (#146; the rule: fidelity-tiers.md § Sibling variance probe).
 *
 * sibling-variance probes the template's block selectors; an article body is one root holding whatever the
 * authors pasted (tables, call-out boxes, embeds, forms, styled wrappers) and the probe sees none of it. The
 * census reads the captured DOM offline (`<current>/pages/<slug>.html`), walks the children of the body root on
 * every page, and tallies each element's signature — `tag.class` (two classes, sorted) plus markers
 * `[style]` (inline style), `[iframe:<host>]`, `[form]`, `[img]`, `[table]` — by pages and items. A class-less
 * `div` / `section` without inline style is a layout wrapper and is walked through. With `--known` each
 * signature is first matched against the encoder's handled kinds; what matches none is UNMAPPED — the list to
 * map in the importer before the wave runs (an unmapped element fails import-run's content count, never a
 * declared drop).
 *
 * Usage:
 *   node prose-census.mjs --body <selector> (--all-of <importer template> | --state-template <t> | --slugs a,b
 *        | --slugs-file <f>) [--known <kinds.json>] [--json <out>] [--top 15] [--state stardust/state.json]
 *        [--current stardust/current] [--importer tools/importer]
 *   --body           the authored-body root on the capture (`main .post-body`; several, comma-separated, first hit)
 *   --all-of         state pages the importer registry (`page-templates.json`) maps to that template
 *   --state-template state pages whose `template` equals this value (e.g. the spec's `/blog/post`)
 *   --known          { "<kind>": ["<selector>", …] } — the kinds the encoder maps (`text`: ["p","h2","ul"], …);
 *                    without it every signature is listed and nothing is unmapped by name
 * Prints: pages read (body root missing on N), kinds (pages · items), then the signatures (UNMAPPED first) with
 * pages · items and up to 3 example slugs + a text snippet. --json writes { pages, kinds, signatures, missingRoot }.
 * Exit: 0 every element mapped (or no --known), 2 unmapped signatures or a page without the body root, 1 error.
 * DOM: linkedom (import-run.mjs loadDom — the script's folder, then the project).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDom, loadTemplates, matchTemplate } from './import-run.mjs';

const HELP = () => readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim();
const VALUE = ['body', 'all-of', 'state-template', 'slugs', 'slugs-file', 'known', 'json', 'top', 'state', 'current', 'importer'];

export function parseArgs(argv) {
  const o = { top: '15', state: 'stardust/state.json', current: 'stardust/current', importer: 'tools/importer' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !VALUE.includes(k)) throw new Error(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    o[k] = argv[i + 1]; i += 1;
  }
  if (!o.body) throw new Error('--body <selector> is required (the authored-body root on the capture)');
  if (!['all-of', 'state-template', 'slugs', 'slugs-file'].some((k) => o[k])) throw new Error('name the pages: --all-of, --state-template, --slugs or --slugs-file');
  return o;
}

const text = (n) => String((n && n.textContent) || '').replace(/\s+/g, ' ').trim();
const classesOf = (n) => String(n.getAttribute('class') || '').split(/\s+/).filter(Boolean);

/** The census signature of one body child. */
export function signature(n) {
  const tag = n.tagName.toLowerCase();
  const cls = classesOf(n).sort().slice(0, 2);
  const marks = [];
  if (n.getAttribute('style')) marks.push('style');
  const iframe = tag === 'iframe' ? n : n.querySelector('iframe[src]');
  if (iframe) { let host = ''; try { host = new URL(iframe.getAttribute('src'), 'https://x.invalid').hostname; } catch { /* keep blank */ } marks.push(`iframe:${host}`); }
  if (tag !== 'form' && n.querySelector('form, input, select')) marks.push('form');
  if (tag !== 'img' && n.querySelector('img')) marks.push('img');
  if (tag !== 'table' && n.querySelector('table')) marks.push('table');
  return `${tag}${cls.map((c) => `.${c}`).join('')}${marks.map((m) => `[${m}]`).join('')}`;
}

/** A class-less, style-less div / section / span holding elements: a layout wrapper, walked through. */
export const isWrapper = (n) => ['div', 'section', 'span', 'center'].includes(n.tagName.toLowerCase()) && !classesOf(n).length
  && !n.getAttribute('style') && !n.getAttribute('id') && n.children.length > 0 && !n.querySelector(':scope > iframe');

/** The body children (wrappers walked) → [{ el, sig, kind }]; `known` = { kind: [selector…] }. */
export function walkBody(root, known = null) {
  const out = [];
  const kindOf = (el) => {
    if (!known) return null;
    for (const [kind, sels] of Object.entries(known)) for (const s of [].concat(sels)) { try { if (el.matches(s)) return kind; } catch { /* selector linkedom cannot parse */ } }
    return 'UNMAPPED';
  };
  const visit = (parent) => {
    for (const el of parent.children) {
      const kind = kindOf(el);
      if ((kind === 'UNMAPPED' || kind === null) && isWrapper(el)) { visit(el); continue; }
      out.push({ el, sig: signature(el), kind });
    }
  };
  visit(root);
  return out;
}

/** Folds per-page walks into the census tables. pages: [{ slug, items: [{ sig, kind, snippet }] | null }]. */
export function tally(pages) {
  const kinds = {}; const sigs = {}; const missingRoot = [];
  for (const p of pages) {
    if (!p.items) { missingRoot.push(p.slug); continue; }
    const seenK = new Set(); const seenS = new Set();
    for (const it of p.items) {
      if (it.kind) { kinds[it.kind] = kinds[it.kind] || { pages: 0, items: 0 }; kinds[it.kind].items += 1; if (!seenK.has(it.kind)) { kinds[it.kind].pages += 1; seenK.add(it.kind); } }
      const s = sigs[it.sig] || (sigs[it.sig] = { sig: it.sig, kind: it.kind, pages: 0, items: 0, examples: [] });
      s.items += 1;
      if (!seenS.has(it.sig)) { s.pages += 1; seenS.add(it.sig); if (s.examples.length < 3) s.examples.push({ slug: p.slug, text: it.snippet }); }
    }
  }
  const signatures = Object.values(sigs).sort((a, b) => (b.kind === 'UNMAPPED') - (a.kind === 'UNMAPPED') || b.pages - a.pages || b.items - a.items);
  return { kinds, signatures, missingRoot };
}

function pickPages(o) {
  const state = existsSync(o.state) ? JSON.parse(readFileSync(o.state, 'utf8')) : { pages: [] };
  const all = Array.isArray(state.pages) ? state.pages : [];
  if (o['all-of']) { const t = loadTemplates(o.importer); const tpl = t.find((x) => x.id === o['all-of']); if (!tpl) throw new Error(`template ${o['all-of']} not in ${o.importer}/page-templates.json`); return all.filter((p) => p.url && matchTemplate(t, p.url) === tpl).map((p) => p.slug); }
  if (o['state-template']) return all.filter((p) => p.template === o['state-template']).map((p) => p.slug);
  return (o.slugs || readFileSync(o['slugs-file'], 'utf8')).split(/[\s,]+/).filter(Boolean);
}

export async function main(argv) {
  const o = parseArgs(argv);
  const known = o.known ? JSON.parse(readFileSync(o.known, 'utf8')) : null;
  const slugs = pickPages(o);
  if (!slugs.length) throw new Error('no pages selected');
  const parseHTML = await loadDom();
  const sels = o.body.split(',').map((s) => s.trim()).filter(Boolean);
  const pages = []; let unread = 0;
  for (const slug of slugs) {
    const f = join(o.current, 'pages', `${slug}.html`);
    if (!existsSync(f)) { unread += 1; continue; }
    const { document } = parseHTML(readFileSync(f, 'utf8'));
    const root = sels.map((s) => document.querySelector(s)).find(Boolean);
    pages.push({ slug, items: root ? walkBody(root, known).map((x) => ({ sig: x.sig, kind: x.kind, snippet: text(x.el).slice(0, 60) })) : null });
  }
  const t = tally(pages);
  const top = Number(o.top);
  console.log(`prose-census: ${pages.length} capture(s) read${unread ? `, ${unread} without a capture` : ''}; body root missing on ${t.missingRoot.length}${t.missingRoot.length ? ` (${t.missingRoot.slice(0, 5).join(', ')})` : ''}`);
  if (known) console.log(`kinds  ${Object.entries(t.kinds).map(([k, v]) => `${k} ${v.pages}p/${v.items}`).join(' · ')}`);
  const unmapped = t.signatures.filter((s) => s.kind === 'UNMAPPED');
  for (const s of [...unmapped, ...t.signatures.filter((x) => x.kind !== 'UNMAPPED').slice(0, top)]) {
    console.log(`${s.kind === 'UNMAPPED' ? 'UNMAPPED ' : `${(s.kind || '-').padEnd(9)}`}${String(s.pages).padStart(5)}p ${String(s.items).padStart(6)}  ${s.sig}  ${s.examples.map((e) => `${e.slug}${e.text ? ` "${e.text.slice(0, 30)}"` : ''}`).join(' · ')}`);
  }
  if (o.json) { mkdirSync(dirname(resolve(o.json)), { recursive: true }); writeFileSync(o.json, `${JSON.stringify({ pages: pages.length, ...t }, null, 1)}\n`); }
  console.log(known ? `prose-census: ${unmapped.length} unmapped signature(s)${unmapped.length ? ' — map each in the encoder before the wave' : ''}` : 'prose-census: no --known — every signature listed');
  return (known && unmapped.length) || t.missingRoot.length ? 2 : 0;
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP()); process.exit(0); }
  main(argv).then((c) => process.exit(c), (e) => { console.error(`prose-census: ${e.message}`); process.exit(1); });
}
