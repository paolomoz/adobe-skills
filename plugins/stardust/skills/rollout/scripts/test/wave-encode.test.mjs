// Contract test for wave-encode.mjs (#146). The pure part (args, web paths, the document plan) needs nothing; the end
// to end wave (a mkdtemp project: importer, captures, a delivered tree, a media hook) runs migrate's import-run, which
// needs `linkedom` — skipped where it does not resolve (run from a project copy:
// node --test stardust/scripts/rollout/test/wave-encode.test.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, planDocs, webPathOf } from '../wave-encode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'wave-encode.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('--help prints the header and writes nothing; usage errors exit 2', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wave-encode-help-'));
  const r = run(['--help'], cwd);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /changed\.txt/); assert.match(r.stdout, /--media/);
  assert.equal(run(['--template', 'x'], cwd).status, 2);
  assert.deepEqual(readdirSync(cwd), []);
  rmSync(cwd, { recursive: true, force: true });
});

test('parseArgs: required flags and defaults', () => {
  assert.throws(() => parseArgs(['--template', 'post', '--work', 'w', '--source-host', 'example.com']), /--slugs or --slugs-file/);
  assert.throws(() => parseArgs(['--template', 'post', '--slugs', 'a', '--work', 'w']), /--source-host is required/);
  const o = parseArgs(['--template', 'post', '--slugs', 'a,b', '--work', 'w', '--source-host', 'example.com']);
  assert.equal(o.content, 'content'); assert.equal(o.importer, 'tools/importer');
});

test('webPathOf + planDocs: pages always; a fragment only when the tree has none', () => {
  const out = join('w', 'out');
  assert.equal(webPathOf(join(out, 'blog', 'a.html'), out), '/blog/a');
  const rows = [{ files: [join(out, 'blog/a.html'), join(out, 'fragments/author/x.html'), join(out, 'fragments/post/part.html')] }, { files: [join(out, 'blog/b.html'), join(out, 'fragments/post/part.html')] }, { error: 'boom' }];
  const p = planDocs(rows, out, (path) => path === '/fragments/post/part');
  assert.deepEqual(p, { pages: ['/blog/a', '/blog/b'], newFragments: ['/fragments/author/x'], keptFragments: ['/fragments/post/part'] });
});

async function linkedomResolves() {
  try { await import('linkedom'); return true; } catch { /* try cwd */ }
  try { createRequire(join(process.cwd(), 'package.json')).resolve('linkedom'); return true; } catch { return false; }
}

test('end to end: import → media hook → links → sanitise; only changed documents copied; delivered fragments kept', async (t) => {
  if (!(await linkedomResolves())) { t.skip('linkedom not resolvable here — run from a project copy'); return; }
  if (!existsSync(join(HERE, '..', '..', 'migrate', 'scripts', 'import-run.mjs')) && !existsSync(join(HERE, '..', '..', 'migrate', 'import-run.mjs'))) { t.skip('migrate scripts not beside rollout'); return; }
  const root = mkdtempSync(join(tmpdir(), 'wave-encode-e2e-'));
  const w = (rel, data) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); };
  w('package.json', '{"name":"p","private":true}');
  w('tools/importer/package.json', '{"type":"module"}');
  w('tools/importer/page-templates.json', JSON.stringify({ templates: [{ name: 'post', patterns: ['/blog/*'] }] }));
  w('tools/importer/import-post.js', `export default { transform: ({ document, url }) => {
  const main = document.querySelector('main');
  const frag = document.createElement('main'); frag.innerHTML = '<div><p>Shared part</p></div>';
  const a = document.createElement('p'); a.innerHTML = '<a href="/fragments/post/part">part</a>'; main.append(a);
  return [{ element: main, path: new URL(url).pathname }, { element: frag, path: '/fragments/post/part' }];
} };`);
  const page = (title, link) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>Café ${link}</p></main></body></html>`;
  w('stardust/current/pages/blog-a.html', page('Alpha', '<a href="https://www.example.com/blog/b">B</a>'));
  w('stardust/current/pages/blog-b.html', page('Beta', '<a href="https://www.example.com/blog/zz">later</a>'));
  w('stardust/state.json', JSON.stringify({ pages: ['a', 'b'].map((s) => ({ slug: `blog-${s}`, url: `https://www.example.com/blog/${s}` })) }));
  w('content/fragments/post/part.html', '<body><main><div><p>Shared part</p><p>delivered copy</p></div></main></body>');
  const args = ['--template', 'post', '--slugs', 'blog-a,blog-b', '--work', 'work', '--source-host', 'example.com', '--media', 'echo media on $WAVE_OUT > work/media.txt'];
  const r = run(args, root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(join(root, 'work/changed.txt'), 'utf8').trim().split('\n'), ['/blog/a', '/blog/b']);
  const a = readFileSync(join(root, 'content/blog/a.html'), 'utf8');
  assert.match(a, /href="\/blog\/b"/, 'a link to a page of the same wave is localised'); assert.match(a, /Caf&eacute;|Caf&#233;|Caf&#xE9;/i, 'sanitised');
  assert.match(readFileSync(join(root, 'content/fragments/post/part.html'), 'utf8'), /delivered copy/, 'the delivered fragment is kept');
  assert.match(readFileSync(join(root, 'work/media.txt'), 'utf8'), /work\/out/);
  const again = run(args, root);
  assert.equal(again.status, 0, again.stdout + again.stderr); assert.equal(readFileSync(join(root, 'work/changed.txt'), 'utf8'), '', 'idempotent: nothing changes on a re-run');
  rmSync(root, { recursive: true, force: true });
});
