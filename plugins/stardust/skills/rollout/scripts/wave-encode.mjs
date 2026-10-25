#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * rollout/wave-encode.mjs — one command per template wave (#146): import → media → links → sanitise, touching only
 * the wave's documents, and the list of documents that changed (the rule: rollout SKILL.md Phase C § Template waves).
 *
 *   1. import  migrate's import-run.mjs --template <id> --slugs … into <work>/out, seeded with the delivered
 *              `<content>/fragments/` (a page referencing a part another page emitted earlier is credited);
 *              a failed content count stops the wave (fix the encoder, never declare the loss away).
 *   2. media   --media "<command>" runs on the out dir (`{out}` in the command, or WAVE_OUT in its environment) —
 *              the project's rehost step (da-media-upload by manifest, its own naming); without it the images keep
 *              their source URLs and media-reconcile holds the PUT.
 *   3. links   deploy's localize-links.mjs on a scratch copy of the WHOLE tree with the wave's documents in it (a
 *              link resolves to every page already delivered); the repoint ledger stays the wave close's (#145).
 *   4. sanitise deploy's sanitise.js per document.
 * Then each wave document that differs from `<content><path>.html` is copied into the tree. A fragment document is
 * copied only when the tree has none (a new part); a delivered fragment is never overwritten by the importer's copy
 * (delivery rewrote its links and media).
 *
 * Usage:
 *   node wave-encode.mjs --template <importer id> (--slugs a,b | --slugs-file <f>) --work <dir> --source-host <host[,host]>
 *        [--content content] [--redirects stardust/redirects.tsv] [--media "<command>"] [--importer tools/importer]
 *        [--state stardust/state.json] [--current stardust/current]
 * Writes: <work>/out/ (the import), <work>/import.json, <work>/paths.txt (every wave document's web path),
 * <work>/changed.txt (those copied into <content> — `deploy-batch.mjs --paths <work>/changed.txt`), and the changed
 * documents under <content>. Exit: 0 encoded, 2 usage or a failed step (nothing copied into <content>), 1 error.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALUE = ['template', 'slugs', 'slugs-file', 'work', 'source-host', 'content', 'redirects', 'media', 'importer', 'state', 'current'];

export function parseArgs(argv) {
  const o = { content: 'content', redirects: 'stardust/redirects.tsv', importer: 'tools/importer', state: 'stardust/state.json', current: 'stardust/current' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !VALUE.includes(k)) throw new Error(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    o[k] = argv[i + 1]; i += 1;
  }
  for (const k of ['template', 'work', 'source-host']) if (!o[k]) throw new Error(`--${k} is required`);
  if (!o.slugs && !o['slugs-file']) throw new Error('--slugs or --slugs-file is required');
  return o;
}

/** `<out>/blog/x.html` → `/blog/x`; `<out>/index.html` → `/index`. */
export const webPathOf = (file, out) => `/${relative(out, file).split(sep).join('/').replace(/\.html$/, '')}`;

/** The wave's documents from import-run's --json rows: pages always, a fragment only when the tree has none. */
export function planDocs(rows, out, inTree) {
  const pages = []; const newFragments = []; const keptFragments = [];
  for (const r of rows) {
    for (const f of r.files || []) {
      const p = webPathOf(f, out);
      if (!p.startsWith('/fragments/')) { if (!pages.includes(p)) pages.push(p); } else if (inTree(p)) { if (!keptFragments.includes(p)) keptFragments.push(p); } else if (!newFragments.includes(p)) newFragments.push(p);
    }
  }
  return { pages, newFragments, keptFragments };
}

const sibling = (skill, file) => [join(HERE, '..', '..', skill, 'scripts', file), join(HERE, '..', skill, file)].find((x) => existsSync(x));
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

export function main(argv) {
  const o = parseArgs(argv);
  const tools = { importRun: sibling('migrate', 'import-run.mjs'), localize: sibling('deploy', 'localize-links.mjs'), sanitise: sibling('deploy', 'sanitise.js') };
  const missing = Object.entries(tools).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw Object.assign(new Error(`not found next to this script: ${missing.join(', ')} (copy the migrate and deploy scripts beside rollout's)`), { code: 2 });
  const slugs = (o.slugs || readFileSync(o['slugs-file'], 'utf8')).split(/[\s,]+/).filter(Boolean);
  const out = join(o.work, 'out'); const json = join(o.work, 'import.json');
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  if (existsSync(join(o.content, 'fragments'))) cpSync(join(o.content, 'fragments'), join(out, 'fragments'), { recursive: true });
  // 1 import
  const imp = node([tools.importRun, '--template', o.template, '--slugs', slugs.join(','), '--source', 'auto', '--out', out, '--json', json, '--importer', o.importer, '--state', o.state, '--current', o.current]);
  writeFileSync(join(o.work, 'import.log'), `${imp.stdout}${imp.stderr}`);
  console.log(`import  ${(imp.stdout.trim().split('\n').pop() || imp.stderr.trim()).slice(0, 200)}`);
  if (imp.status !== 0 || !existsSync(json)) { console.log(imp.stdout.split('\n').filter((l) => /^(FAIL|ERROR| {8}missing)/.test(l)).slice(0, 20).join('\n')); console.log('wave-encode: a page failed the content count — fix the encoder; nothing copied'); return 2; }
  // 2 media
  if (o.media) {
    const m = spawnSync(o.media.replaceAll('{out}', out), { shell: true, encoding: 'utf8', env: { ...process.env, WAVE_OUT: out }, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(o.work, 'media.log'), `${m.stdout}${m.stderr}`);
    console.log(`media   exit ${m.status}: ${(m.stdout.trim().split('\n').pop() || '').slice(0, 200)}`);
    if (m.status !== 0) { console.log('wave-encode: the media step failed — see media.log; nothing copied'); return 2; }
  } else console.log('media   no --media: images keep their source URLs (media-reconcile holds the PUT)');
  const rows = JSON.parse(readFileSync(json, 'utf8'));
  const inTree = (p) => existsSync(join(o.content, `${p}.html`));
  const plan = planDocs(rows, out, inTree);
  const docs = [...plan.pages, ...plan.newFragments];
  // 3 links + 4 sanitise on a scratch copy of the whole tree
  const scratch = mkdtempSync(join(tmpdir(), 'wave-encode-')); const tree = join(scratch, 'content');
  try {
    if (existsSync(o.content)) cpSync(o.content, tree, { recursive: true }); else mkdirSync(tree, { recursive: true });
    for (const p of docs) { mkdirSync(dirname(join(tree, `${p}.html`)), { recursive: true }); cpSync(join(out, `${p}.html`), join(tree, `${p}.html`)); }
    const ll = node([tools.localize, '--source-host', o['source-host'], '--content', tree, ...(existsSync(o.redirects) ? ['--redirects', o.redirects] : [])]);
    writeFileSync(join(o.work, 'localize.log'), `${ll.stdout}${ll.stderr}`);
    if (ll.status !== 0) { console.log(`wave-encode: localize-links exit ${ll.status} — see localize.log; nothing copied`); return 2; }
    console.log(`links   ${(ll.stdout.trim().split('\n').find((l) => /rewrote|rewritten|changed/i.test(l)) || ll.stdout.trim().split('\n').pop() || '').slice(0, 200)}`);
    const changed = [];
    for (const p of docs) {
      const f = join(tree, `${p}.html`);
      const s = node([tools.sanitise, f]);
      if (s.status !== 0) { console.log(`wave-encode: sanitise failed on ${p}: ${s.stderr.trim()}; nothing copied`); return 2; }
      const dest = join(o.content, `${p}.html`);
      if (!existsSync(dest) || readFileSync(dest, 'utf8') !== readFileSync(f, 'utf8')) changed.push(p);
    }
    for (const p of changed) { const dest = join(o.content, `${p}.html`); mkdirSync(dirname(dest), { recursive: true }); cpSync(join(tree, `${p}.html`), dest); }
    writeFileSync(join(o.work, 'paths.txt'), docs.map((p) => `${p}\n`).join(''));
    writeFileSync(join(o.work, 'changed.txt'), changed.map((p) => `${p}\n`).join(''));
    console.log(`wave-encode ${o.template}: ${plan.pages.length} page(s) + ${plan.newFragments.length} new fragment(s) (${plan.keptFragments.length} delivered fragment(s) kept), ${changed.length} changed → ${join(o.work, 'changed.txt')}`);
    return 0;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim()); process.exit(0); }
  try { process.exit(main(argv)); } catch (e) { console.error(`wave-encode: ${e.message}`); process.exit(e.code === 2 || /required|needs a value|unknown argument/.test(e.message) ? 2 : 1); }
}
