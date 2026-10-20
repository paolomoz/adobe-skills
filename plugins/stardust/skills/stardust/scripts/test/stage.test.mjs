#!/usr/bin/env node
// skills/stardust/scripts/test/stage.test.mjs — the stage.mjs contract: --help before any I/O; usage errors (no skill,
// unknown skill, a value flag without its value, no plugin root) exit 2 and name the fix; staging copies each named
// skill's scripts/ to <to>/<skill>/ and ALWAYS lib/ to <to>/lib/ plus the package.json that maps `#lib/*` onto it (an
// existing package.json keeps its other keys); the run is idempotent; it prints what it copied; --all stages every skill
// that ships scripts; --from accepts another plugin root; and the staged copies import `#lib/*` through the written map.
// Pure: no browser, no network, no node_modules. Run: node <this file>.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'stage.mjs');
const PLUGIN = join(HERE, '..', '..', '..', '..');
const SKILLS = join(PLUGIN, 'skills');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'stage-test-'))); // realpath: a module's import.meta.url is the resolved path
const run = (args, cwd = root) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const walk = (dir, base = dir, acc = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, base, acc); else acc.push(p.slice(base.length + 1)); } return acc.sort(); };
/** Import a staged module in a child process (the `#lib/*` map is read from the nearest package.json, so it must be a real file). */
const importIn = (file, expr) => spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(JSON.stringify(${expr}));`], { encoding: 'utf8' });
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`✓ ${name}`); } catch (e) { failed += 1; console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`); } };

check('--help prints the usage and writes nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stage-help-'));
  const r = run(['--help'], cwd);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Usage:/); assert.match(r.out, /--from/); assert.match(r.out, /--all/);
  assert.deepEqual(readdirSync(cwd), []); rmSync(cwd, { recursive: true, force: true });
});
check('usage errors exit 2 and say what to do: no skill, unknown skill, a flag without its value, a bad --from', () => {
  let r = run([]); assert.equal(r.code, 2); assert.match(r.err, /name at least one skill or pass --all/); assert.match(r.err, /available: .*rollout/);
  r = run(['rollout', 'no-such-skill']); assert.equal(r.code, 2); assert.match(r.err, /no scripts\/ dir for: no-such-skill/);
  r = run(['rollout', '--to']); assert.equal(r.code, 2); assert.match(r.err, /--to needs a value/);
  r = run(['rollout', '--to', '--all']); assert.equal(r.code, 2); assert.match(r.err, /--to needs a value/);
  r = run(['rollout', '--from', join(root, 'nowhere')]); assert.equal(r.code, 2); assert.match(r.err, /not a stardust plugin root/);
  r = run(['rollout', '--bogus']); assert.equal(r.code, 2); assert.match(r.err, /unknown flag --bogus/);
  assert.ok(!existsSync(join(root, 'stardust')), 'a usage error stages nothing');
});

const to = join(root, 'proj', 'stardust', 'scripts');
check('staging two skills copies their scripts/, ALWAYS lib/, and the #lib import map; prints each copy', () => {
  const r = run(['rollout', 'deploy', '--to', to]);
  assert.equal(r.code, 0, r.err);
  for (const f of ['rollout/lib.mjs', 'rollout/inventory.mjs', 'rollout/test/inventory.test.mjs', 'deploy/eds-path.mjs', 'lib/paths.mjs', 'lib/names.mjs', 'lib/kinds.mjs', 'lib/taxonomy.mjs', 'lib/resolve.mjs', 'lib/README.md', 'package.json']) {
    assert.ok(existsSync(join(to, f)), `${f} staged`);
  }
  assert.ok(!existsSync(join(to, 'qa')), 'an unnamed skill is not staged');
  const pkg = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module'); assert.equal(pkg.imports['#lib/*'], './lib/*');
  assert.match(r.out, /staged rollout\s+→ .*rollout\/ \(\d+ files\)/); assert.match(r.out, /staged deploy\s+→ /); assert.match(r.out, /staged lib\s+→ .*lib\/ \(\d+ files\)/); assert.match(r.out, /wrote .*package\.json \(#lib\/\* → \.\/lib\/\*\)/);
  // byte-identical copies of the plugin tree
  for (const f of walk(join(SKILLS, 'rollout', 'scripts'))) assert.ok(readFileSync(join(SKILLS, 'rollout', 'scripts', f)).equals(readFileSync(join(to, 'rollout', f))), `${f} identical`);
  assert.deepEqual(walk(join(to, 'lib')), walk(join(SKILLS, 'stardust', 'scripts', 'lib')));
});
check('the staged copies resolve #lib/* through the written map: rollout/lib.mjs re-exports, deploy/eds-path.mjs re-exports', () => {
  let r = importIn(join(to, 'rollout', 'lib.mjs'), '[m.edsName("Hero Banner"), m.kindOf("nav"), m.pageWidgets({ widgets: [{ href: "/widgets/search/site-search.html?q=1" }] })[0].id, m.publicUrl({ path: "/a", source: { migratedHtml: "a/index.html" } })]');
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), '["hero-banner","chrome","site-search","/a/"]');
  r = importIn(join(to, 'deploy', 'eds-path.mjs'), '[m.pathKey("/A/index.html"), m.deliveredUrl("/a/index.html"), m.daPath("/a/")]');
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), '["/a","/a/","/a/index"]');
  r = importIn(join(to, 'lib', 'resolve.mjs'), '[m.layout(), m.siblingPath("deploy", "eds-path.mjs")]');
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), ['project', join(to, 'deploy', 'eds-path.mjs')]);
});
check('idempotent: a second run reproduces the same tree; an existing package.json keeps its other keys', () => {
  const before = walk(to);
  writeFileSync(join(to, 'package.json'), JSON.stringify({ name: 'proj-scripts', imports: { '#other/*': './other/*' } }));
  const r = run(['rollout', 'deploy', '--to', to]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(walk(to), before);
  const pkg = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'proj-scripts'); assert.equal(pkg.imports['#other/*'], './other/*'); assert.equal(pkg.imports['#lib/*'], './lib/*'); assert.equal(pkg.type, 'module');
});
check('--all stages every skill that ships a scripts/ dir, and nothing else', () => {
  const all = join(root, 'all');
  const r = run(['--all', '--to', all]);
  assert.equal(r.code, 0, r.err);
  const expected = readdirSync(SKILLS).filter((s) => existsSync(join(SKILLS, s, 'scripts')) && statSync(join(SKILLS, s, 'scripts')).isDirectory()).sort();
  const staged = readdirSync(all).filter((d) => statSync(join(all, d)).isDirectory() && d !== 'lib').sort();
  assert.deepEqual(staged, expected);
  assert.ok(existsSync(join(all, 'stardust', 'stage.mjs')) && !existsSync(join(all, 'stardust', 'lib')), 'the stardust skill is staged without a second lib/ copy');
  assert.equal((r.out.match(/^staged /gm) || []).length, expected.length + 1, 'one line per skill plus lib');
});
check('--from stages from another plugin root (its skills, its lib)', () => {
  const plug = join(root, 'plug');
  mkdirSync(join(plug, '.claude-plugin'), { recursive: true }); writeFileSync(join(plug, '.claude-plugin', 'plugin.json'), '{}');
  mkdirSync(join(plug, 'skills', 'stardust', 'scripts', 'lib'), { recursive: true }); writeFileSync(join(plug, 'skills', 'stardust', 'scripts', 'lib', 'x.mjs'), 'export const x = 1;\n');
  mkdirSync(join(plug, 'skills', 'foo', 'scripts'), { recursive: true }); writeFileSync(join(plug, 'skills', 'foo', 'scripts', 'a.mjs'), "import { x } from '#lib/x.mjs'; console.log(x);\n");
  mkdirSync(join(plug, 'skills', 'bar'), { recursive: true }); // no scripts/: not stageable
  const out = join(root, 'from');
  let r = run(['foo', '--from', plug, '--to', out]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(walk(out), ['foo/a.mjs', 'lib/x.mjs', 'package.json']);
  const ran = spawnSync(process.execPath, [join(out, 'foo', 'a.mjs')], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr); assert.equal(ran.stdout.trim(), '1');
  r = run(['bar', '--from', plug, '--to', out]); assert.equal(r.code, 2); assert.match(r.err, /no scripts\/ dir for: bar \(available: foo stardust\)/);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
