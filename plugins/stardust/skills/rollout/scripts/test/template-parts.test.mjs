#!/usr/bin/env node
// Contract test for rollout/scripts/template-parts.mjs (#143): parts of a DA document (sections,
// blocks, keyed rows, default-content runs), the normalisation (images by file name, the page's own
// path/title, declared slots), template parts with their home, nesting, entity parts keyed by a
// metadata row, references not counted again, shared parts across groups, and a CLI run over a
// fixture project (--templates, --check). Pure: no DOM library.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  normalise, partsOf, metadataOf, rowKey, isReference, prepare, analyse, crossGroups, parseArgs,
} from '../template-parts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'template-parts.mjs');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`); } };

const PROMO = '<div><div><p>promo</p></div><div><h4>Try the product</h4><p>Every plan has a free trial, cancel any time you like.</p><p><a href="/pricing">Start now</a></p></div></div>';
const card = (who) => `<div><div><p>author</p></div><div><p>Written by</p><p><img src="https://cdn.test/${who}.png" alt="${who}"></p><p>${who} writes about markets and trends, ten years of experience.</p></div></div>`;
const BANNER = '<div class="banner dark"><div><div><h2>Get the newsletter every week</h2><p>One e-mail a week with the trends that matter, never more.</p></div></div></div>';
const doc = ({ title, author, body, banner = true, promo = PROMO, scope = 'x' }) => '<body><header></header><main>'
  + `<div><h1>${title}</h1><div class="article-body post"><div><div><p>title</p></div><div><p>${title}</p></div></div>${promo}<div><div><p>share</p></div><div><p>Share</p></div></div></div><p>${body}</p></div>`
  + `<div><div class="article-footer">${card(author)}</div>${banner ? BANNER : ''}<p><img src="https://content.test/media/${scope}/shared-art.png" alt=""></p></div>`
  + `<div><div class="metadata"><div><div>Title</div><div>${title}</div></div><div><div>Author</div><div>${author}</div></div></div></div>`
  + '</main><footer></footer></body>';

check('rowKey: a short plain first cell keys the row; links, images, headings do not', () => {
  assert.equal(rowKey([{ inner: '<p>free-data</p>' }, { inner: 'x' }]), 'free-data');
  assert.equal(rowKey([{ inner: '<p><a href="/x">x</a></p>' }, { inner: 'x' }]), null);
  assert.equal(rowKey([{ inner: '<p>a much longer first cell here</p>' }, { inner: 'x' }]), null);
  assert.equal(rowKey([{ inner: '<p>solo</p>' }]), null);
});

check('partsOf: sections, blocks, keyed rows, default-content runs; metadata skipped', () => {
  const parts = partsOf(doc({ title: 'A', author: 'Ann', body: 'Alpha' }));
  const slots = parts.map((p) => `${p.level}:${p.slot}`);
  assert.ok(slots.includes('section:section:article-body'));
  assert.ok(slots.includes('block:article-body.post'));
  assert.ok(slots.includes('row:article-body/promo'));
  assert.ok(slots.includes('content:article-body/content'));
  assert.ok(slots.includes('block:banner.dark'));
  assert.ok(!slots.some((s) => s.includes('metadata')));
  const row = parts.find((p) => p.slot === 'article-body/promo');
  assert.equal(parts[row.parent].level, 'block');
  assert.deepEqual(metadataOf(doc({ title: 'A', author: 'Ann', body: 'x' })), { title: 'A', author: 'Ann' });
});

check('normalise: images by file name, the page itself and declared slots masked, entities folded', () => {
  const a = normalise('<p><img src="https://content.test/media/page-a/art.png?w=2" alt="x"> Read &ldquo;A&rdquo; at /blog/a</p>', { self: ['/blog/a'] });
  const b = normalise('<p><img src="https://content.test/media/page-b/art.png" alt="x"> Read "A" at /blog/b</p>', { self: ['/blog/b'] });
  assert.equal(a, b);
  const s = [/utm_campaign=[\w-]+/gi];
  assert.equal(normalise('<a href="/x?utm_campaign=one">x</a>', { slots: s }), normalise('<a href="/x?utm_campaign=two">x</a>', { slots: s }));
});

check('isReference: fragment blocks and parts rows are references, content is not', () => {
  assert.ok(isReference('<div class="fragment"><div><div><p><a href="/fragments/a/b">/fragments/a/b</a></p></div></div></div>'));
  assert.ok(isReference('<div><div><p>parts</p></div><div><p><a href="/fragments/a">/fragments/a</a></p></div></div>'));
  assert.ok(!isReference('<p>Read the <a href="/fragments/a">guide</a> first</p>'));
  assert.ok(!isReference(PROMO));
});

const pages = [
  { page: '/blog/a', html: doc({ title: 'Alpha', author: 'Ann', body: 'First story', scope: 'a' }) },
  { page: '/blog/b', html: doc({ title: 'Beta', author: 'Ann', body: 'Second story', scope: 'b' }) },
  { page: '/blog/c', html: doc({ title: 'Gamma', author: 'Bob', body: 'Third story', banner: false, scope: 'c' }) },
  { page: '/blog/d', html: doc({ title: 'Delta', author: 'Bob', body: 'Fourth story', scope: 'd' }) },
];

check('analyse: template parts with share and home, entity parts by metadata, body not a part', () => {
  const r = analyse('post', prepare(pages), { threshold: 0.5, minBytes: 40 });
  const by = Object.fromEntries(r.candidates.map((c) => [c.slot, c]));
  assert.equal(by['article-body/promo'].pages.length, 4);
  assert.equal(by['article-body/promo'].home, 'inject'); // every page, same position
  assert.equal(by['banner.dark'].pages.length, 3);
  assert.equal(by['banner.dark'].home, 'reference');
  assert.equal(by['banner.dark'].path, '/fragments/post/banner-dark');
  assert.ok(!r.candidates.some((c) => /First story/.test(c.text)));
  assert.equal(r.entities.length, 1);
  const [e] = r.entities;
  assert.deepEqual([e.slot, e.key, e.entities, e.pages.length, e.conflicts], ['article-footer', 'author', 2, 4, 0]); // the outermost part the value explains
  assert.equal(e.path, '/fragments/author/<author>');
  assert.ok(r.bytes.after < r.bytes.before);
});

check('analyse: a part nested in a candidate with the same pages is not repeated; references are not parts', () => {
  const same = ['Uno', 'Dos', 'Tres', 'Cuatro'].map((title, i) => ({ page: `/blog/${i}`, html: doc({ title, author: 'Ann', body: `Story ${i}`, scope: `s${i}`, banner: i !== 2 }) }));
  const r = analyse('post', prepare(same), { threshold: 0.5, minBytes: 40 });
  assert.ok(r.candidates.some((c) => c.slot === 'article-footer'));
  assert.ok(!r.candidates.some((c) => c.slot === 'article-footer/author'));
  const ref = '<div><div><p>parts</p></div><div><p><a href="/fragments/post/body">/fragments/post/body</a></p></div></div>';
  const done = pages.map((p) => ({ ...p, html: p.html.replace(PROMO, ref) }));
  const r2 = analyse('post', prepare(done), { threshold: 0.5, minBytes: 40 });
  assert.ok(!r2.candidates.some((c) => /parts/.test(c.slot) || c.slot === 'article-body/row1'));
  assert.equal(r2.fragmentRefs['/fragments/post/body'], 4);
});

check('crossGroups: a candidate of two groups is shared, its path moves to /fragments/shared/', () => {
  const r1 = analyse('post', prepare(pages), { minBytes: 40 });
  const r2 = analyse('news', prepare(pages.map((p) => ({ ...p, page: p.page.replace('/blog/', '/news/') }))), { minBytes: 40 });
  const shared = crossGroups([r1, r2]);
  assert.ok(shared.some((s) => s.name === 'article-body-promo' && s.groups.length === 2));
  assert.equal(r1.candidates.find((c) => c.slot === 'article-body/promo').path, '/fragments/shared/article-body-promo');
});

check('parseArgs: a source is required, the threshold is a share', () => {
  assert.throws(() => parseArgs([]), /--templates/);
  assert.throws(() => parseArgs(['--by-meta', 'template', '--threshold', '2']), /share/);
  assert.equal(parseArgs(['--templates', 't.json', '--slot', 'utm_\\w+']).slots.length, 1);
});

check('CLI: --help before I/O; a fixture project by --templates; --check exits 2 on a candidate', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const root = mkdtempSync(join(tmpdir(), 'template-parts-'));
  const w = (rel, data) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };
  w('tools/importer/page-templates.json', JSON.stringify({ templates: [{ name: 'post', patterns: ['/blog/*'] }] }));
  pages.forEach((p) => w(`content${p.page}.html`, p.html));
  w('content/fragments/x.html', pages[0].html);
  const r = spawnSync(process.execPath, [SCRIPT, '--templates', 'tools/importer/page-templates.json', '--min-bytes', '40', '--check', '--json', 'out/p.json'], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /post: 4 pages, part on ≥ 2 pages/);
  assert.match(r.stdout, /entity article-footer /);
  assert.match(r.stdout, /template-parts: 1 groups, \d+ template parts, 1 entity parts, 0 shared; median document/);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall template-parts checks passed');
