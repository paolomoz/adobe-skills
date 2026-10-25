// Contract test for prose-census.mjs (#146). The pure part (args, the tally) needs no DOM library; the end-to-end
// census (a mkdtemp project with captures and a state file) needs `linkedom` and is skipped where it does not
// resolve (run it from a project copy: node --test stardust/scripts/migrate/test/prose-census.test.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, tally } from '../prose-census.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'prose-census.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('--help prints the header and writes nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'prose-census-help-'));
  const r = run(['--help'], cwd);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--state-template/); assert.match(r.stdout, /UNMAPPED/);
  assert.deepEqual(readdirSync(cwd), []);
  rmSync(cwd, { recursive: true, force: true });
});

test('parseArgs: --body and a page selector are required; a value flag never swallows a flag', () => {
  assert.throws(() => parseArgs(['--slugs', 'a']), /--body/);
  assert.throws(() => parseArgs(['--body', '.x']), /name the pages/);
  assert.throws(() => parseArgs(['--body', '--slugs', 'a']), /--body needs a value/);
  assert.throws(() => parseArgs(['--body', '.x', '--bogus', '1']), /unknown argument/);
  assert.equal(parseArgs(['--body', '.x', '--state-template', '/blog/post']).current, 'stardust/current');
});

test('tally: kinds and signatures by pages and items, unmapped first, missing roots listed', () => {
  const t = tally([
    { slug: 'a', items: [{ sig: 'p', kind: 'text', snippet: 'x' }, { sig: 'p', kind: 'text', snippet: 'y' }, { sig: 'div.box[style]', kind: 'UNMAPPED', snippet: 'Try it' }] },
    { slug: 'b', items: [{ sig: 'p', kind: 'text', snippet: 'z' }, { sig: 'table', kind: 'table', snippet: '' }] },
    { slug: 'c', items: null },
  ]);
  assert.deepEqual(t.kinds.text, { pages: 2, items: 3 }); assert.deepEqual(t.missingRoot, ['c']);
  assert.equal(t.signatures[0].sig, 'div.box[style]'); assert.deepEqual(t.signatures[0].examples, [{ slug: 'a', text: 'Try it' }]);
  assert.deepEqual(t.signatures.find((s) => s.sig === 'p'), { sig: 'p', kind: 'text', pages: 2, items: 3, examples: [{ slug: 'a', text: 'x' }, { slug: 'b', text: 'z' }] });
});

async function linkedomResolves() {
  try { await import('linkedom'); return true; } catch { /* try cwd */ }
  try { createRequire(join(process.cwd(), 'package.json')).resolve('linkedom'); return true; } catch { return false; }
}

test('end to end: wrappers walked, markers, unmapped → exit 2; all mapped → exit 0', async (t) => {
  if (!(await linkedomResolves())) { t.skip('linkedom not resolvable here — run from a project copy'); return; }
  const root = mkdtempSync(join(tmpdir(), 'prose-census-e2e-'));
  const w = (rel, data) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };
  w('stardust/state.json', JSON.stringify({ pages: [{ slug: 'p1', url: 'https://example.com/blog/p1', template: '/blog/post' }, { slug: 'p2', url: 'https://example.com/blog/p2', template: '/blog/post' }] }));
  w('stardust/current/pages/p1.html', '<main><article class="body"><p>One</p><div align="left"><table><tr><td>x</td></tr></table></div><div class="cta" style="background:#000"><h3>Try</h3><a href="/x">Go</a></div></article></main>');
  w('stardust/current/pages/p2.html', '<main><article class="body"><p>Two</p><div class="embed"><iframe src="https://video.example/e/1"></iframe></div></article></main>');
  w('known.json', JSON.stringify({ text: ['p', 'h2', 'h3'], table: ['table'] }));
  const cwd = root;
  const r = run(['--body', 'article.body', '--state-template', '/blog/post', '--known', 'known.json', '--json', 'out/census.json'], cwd);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const j = JSON.parse(readFileSync(join(root, 'out/census.json'), 'utf8'));
  assert.deepEqual(j.signatures.filter((s) => s.kind === 'UNMAPPED').map((s) => s.sig).sort(), ['div.cta[style]', 'div.embed[iframe:video.example]']);
  assert.deepEqual(j.kinds.table, { pages: 1, items: 1 }, 'the class-less wrapper is walked through to its table');
  w('known.json', JSON.stringify({ text: ['p'], table: ['table'], card: ['div.cta'], embed: ['div.embed'] }));
  assert.equal(run(['--body', 'article.body', '--slugs', 'p1,p2', '--known', 'known.json'], cwd).status, 0);
  rmSync(root, { recursive: true, force: true });
});
