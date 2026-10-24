// Contract test for import-run.mjs (#140). The pure part (args, structured-source adapters, block
// names, template matching, keys, the content-count and outline diffs) needs no DOM library; the
// end-to-end run (a mkdtemp project with an AEM-convention importer, a capture and a state file)
// needs `linkedom` and is skipped where it does not resolve (the plugin tree ships no node_modules —
// run it from a project copy: node --test stardust/scripts/migrate/test/import-run.test.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  balancedJson, blockClass, checkCoverage, diffOutlines, extractSource, externalFor, hrefKey, imageKey,
  matchTemplate, norm, parseArgs, sanitizePath,
} from '../import-run.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'import-run.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('--help answers before any I/O', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'import-run-help-'));
  const r = run(['--help'], cwd);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /params\.source/);
});

test('parseArgs: required forms, value flags, unknown flags', () => {
  assert.equal(parseArgs(['--all-of', 'post']).out, 'content');
  assert.deepEqual(parseArgs(['--template', 't', '--url', 'https://a.test/x', '--url', 'https://a.test/y']).urls, ['https://a.test/x', 'https://a.test/y']);
  assert.throws(() => parseArgs([]), /--template/);
  assert.throws(() => parseArgs(['--template', 't']), /--slugs/);
  assert.throws(() => parseArgs(['--all-of', '--out']), /needs a value/);
  assert.throws(() => parseArgs(['--all-of', 't', '--bogus']), /unknown flag/);
  assert.throws(() => parseArgs(['--all-of', 't', '--source', 'xml']), /--source/);
});

test('structured source: both __NEXT_DATA__ forms, JSON-LD with control characters, meta', () => {
  const tagged = '<script id="__NEXT_DATA__" type="application/json">{"page":"/p","props":{"pageProps":{"post":{"title":"T"}}}}</script>';
  assert.equal(extractSource(tagged).nextData.props.pageProps.post.title, 'T');
  const assigned = '<script>__NEXT_DATA__ = {"page":"/p","s":"a } { \\" b","props":{}};__NEXT_LOADED_PAGES__=[];</script>';
  assert.equal(extractSource(assigned).nextData.s, 'a } { " b');
  const ld = '<script type="application/ld+json">{"@type":"Article","name":"a\u0001b"}</script><script type="application/ld+json">[{"@type":"X"}]</script>';
  assert.deepEqual(extractSource(ld).jsonLd.map((o) => o['@type']), ['Article', 'X']);
  const head = '<title>A &amp; B</title><meta name="description" content="D &quot;q&quot; it\'s"><meta property="og:image" content="https://a.test/i.png">';
  const s = extractSource(head);
  assert.equal(s.title, 'A & B');
  const svgFirst = '<html><head><meta name="x" content="1"><title>Page</title></head><body><svg><title>Icon</title></svg></body></html>';
  assert.equal(extractSource('<svg><title>Icon</title></svg>' + head).title, 'A & B');
  assert.equal(extractSource(svgFirst.replace('<title>Page</title>', '')).title, null);
  assert.equal(extractSource(svgFirst).title, 'Page');
  assert.equal(s.meta.description, 'D "q" it\'s');
  assert.equal(s.meta['og:image'], 'https://a.test/i.png');
  assert.equal(extractSource(tagged, 'none').nextData, null);
  assert.equal(extractSource(tagged, 'json-ld').nextData, null);
  assert.equal(balancedJson('{"a":{', 0), null);
});

test('externalFor picks the entry by slug, URL or path', () => {
  const doc = { 'blog-x': { a: 1 }, '/blog/y': { b: 2 } };
  assert.deepEqual(externalFor(doc, 'blog-x', 'https://s.test/blog/x'), { a: 1 });
  assert.deepEqual(externalFor(doc, 'blog-y', 'https://s.test/blog/y/'), { b: 2 });
  assert.equal(externalFor(doc, 'z', 'https://s.test/z'), doc);
  assert.equal(externalFor(null, 'z', 'u'), null);
});

test('block names, paths, template matching', () => {
  assert.equal(blockClass('Cards (news, Dark Mode)'), 'cards news dark-mode');
  assert.equal(blockClass('Section Metadata'), 'section-metadata');
  assert.equal(sanitizePath('/Blog/My Post/'), '/blog/my-post');
  assert.equal(sanitizePath('/'), '/index');
  const tpls = [{ id: 'post', patterns: ['/blog/*'] }, { id: 'library', urls: ['https://s.test/blog/library'] }, { id: 'deep', patterns: ['/docs/**'] }];
  assert.equal(matchTemplate(tpls, 'https://s.test/blog/library/').id, 'library');
  assert.equal(matchTemplate(tpls, 'https://s.test/blog/a').id, 'post');
  assert.equal(matchTemplate(tpls, 'https://s.test/blog/a/b'), null);
  assert.equal(matchTemplate(tpls, 'https://s.test/docs/a/b').id, 'deep');
});

test('match keys: text, images, hrefs', () => {
  assert.equal(norm('  It’s — “ok”…  '), 'it\'s - "ok"...');
  assert.equal(imageKey('https://cdn.test/resize=w:80/output=f:webp/AbC'), 'abc');
  assert.equal(imageKey('/_next/image?url=%2Fimg%2Fhero.png&w=640'), 'hero');
  assert.equal(imageKey('data:image/png;base64,xx'), null);
  assert.equal(hrefKey('https://s.test/a/?utm=1', 'https://s.test/p'), '/a');
  assert.equal(hrefKey('/a', 'https://s.test/p'), '/a');
  assert.equal(hrefKey('https://o.test/x/', 'https://s.test/p'), 'o.test/x');
  assert.equal(hrefKey('#top', 'https://s.test/p'), null);
});

test('checkCoverage: found, declared and missing per role', () => {
  const src = {
    headings: [{ key: 'title' }, { key: 'gone', declared: true }],
    text: [{ key: 'body text' }, { key: 'lost text' }],
    ctas: [{ label: 'read', href: '/a' }, { label: null, href: '/b' }],
    images: [{ key: 'hero' }, { key: 'thumb' }],
  };
  const doc = { text: 'title body text read', hrefs: new Set(['/a']), images: new Set(['hero']) };
  const r = checkCoverage(src, doc);
  assert.deepEqual(r.counts, { headings: [2, 1], text: [2, 1], ctas: [2, 1], images: [2, 1] });
  assert.equal(r.declared, 1);
  assert.deepEqual(r.missing.map((m) => m.role), ['text', 'ctas', 'images']);
});

test('diffOutlines: same, block shape, text, counts, section count', () => {
  const sec = (blocks, texts, images = 0, links = 0) => ({ blocks, texts, images, links });
  const a = [sec([{ name: 'hero', rows: 1, cols: 1 }], ['h', 'p']), sec([], ['x'], 1, 2)];
  assert.deepEqual(diffOutlines(a, a), []);
  const b = [sec([{ name: 'hero wide', rows: 2, cols: 1 }], ['h', 'q']), sec([], ['x'], 0, 2), sec([], ['y'])];
  const d = diffOutlines(a, b).join('\n');
  assert.match(d, /sections 2 ≠ 3/);
  assert.match(d, /blocks \[hero 1×1\] ≠ \[hero wide 2×1\]/);
  assert.match(d, /text missing 1: "q"/);
  assert.match(d, /text extra 1: "p"/);
  assert.match(d, /images 1 ≠ 0/);
  assert.match(d, /section 3: only in reference/);
});

async function linkedomResolves() {
  try { await import('linkedom'); return true; } catch { /* try cwd */ }
  try { createRequire(join(process.cwd(), 'package.json')).resolve('linkedom'); return true; } catch { return false; }
}

test('end to end: importer convention → DA document, acceptance, compare', async (t) => {
  if (!(await linkedomResolves())) { t.skip('linkedom not resolvable here — run from a project copy'); return; }
  const root = mkdtempSync(join(tmpdir(), 'import-run-e2e-'));
  const w = (rel, data) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };
  w('package.json', '{"name":"p","private":true}');
  w('tools/importer/package.json', '{"type":"module"}');
  w('tools/importer/page-templates.json', JSON.stringify({ templates: [{ name: 'post', patterns: ['/blog/*'] }] }));
  w('tools/importer/parsers/hero.js', `export default function parse(el, { document, params }) {
  const t = params.source.nextData.props.pageProps.post.title;
  const h = document.createElement('h1'); h.textContent = t;
  el.replaceWith(WebImporter.Blocks.createBlock(document, { name: 'Hero (dark)', cells: [[h]] }));
}`);
  w('tools/importer/import-post.js', `import hero from './parsers/hero.js';
export default { transform: ({ document, url, params }) => {
  const main = document.querySelector('main');
  if (params.slug === 'blog-b') WebImporter.DOMUtils.remove(main, ['.share']); // declared
  if (params.slug === 'blog-c') main.querySelector('img').remove(); // silent: a content-count FAIL
  hero(main.querySelector('.hero'), { document, params });
  main.append(document.createElement('hr'));
  main.append(WebImporter.Blocks.getMetadataBlock(document, { Title: params.source.title }));
  return [{ element: main, path: new URL(url).pathname, report: { scope: 'main' } }];
} };`);
  const page = (title, extra) => `<html><head><title>${title}</title></head><body><header><a href="/x">Nav</a></header><main>
<div class="hero"><h1>${title}</h1></div><p>Body <strong>text</strong> here.</p>${extra}</main>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"post":{"title":"${title}"}}}}</script></body></html>`;
  w('stardust/current/pages/blog-a.html', page('Alpha', ''));
  w('stardust/current/pages/blog-b.html', page('Beta', '<div class="share"><a href="https://social.test/s">Share</a></div>'));
  w('stardust/current/pages/blog-c.html', page('Gamma', '<img src="https://cdn.test/lost.png">'));
  w('stardust/state.json', JSON.stringify({ pages: ['a', 'b', 'c'].map((s) => ({ slug: `blog-${s}`, url: `https://s.test/blog/${s}` })) }));
  w('ref/blog/a.html', '<body><header></header><main><div><div class="hero dark"><div><div><h1>Alpha</h1></div></div></div><p>Body <strong>text</strong> here.</p></div><div><div class="metadata"><div><div>Title</div><div>Alpha</div></div></div></div></main><footer></footer></body>');
  const r = run(['--all-of', 'post', '--compare', 'ref'], root);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const doc = readFileSync(join(root, 'content/blog/a.html'), 'utf8');
  assert.match(doc, /^<body><header><\/header><main><div><div class="hero dark"><div><div><h1>Alpha<\/h1><\/div><\/div><\/div><p>Body <strong>text<\/strong> here.<\/p><\/div><div><div class="metadata">/);
  assert.match(r.stdout, /ok {4}blog-a .* = same/);
  assert.match(r.stdout, /ok {4}blog-b .*\[declared 1\]/);
  assert.match(r.stdout, /FAIL {2}blog-c[\s\S]*missing images: lost/);
  assert.match(r.stdout, /import-run post: imported 2, failed 1, errors 0, compared 1 same \/ 2 differ → content/);
});
