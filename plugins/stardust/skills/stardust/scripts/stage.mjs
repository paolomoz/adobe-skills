#!/usr/bin/env node
/**
 * skills/stardust/scripts/stage.mjs — copy skill script sets into a project as `stardust/scripts/<skill>/`, ALWAYS with
 * the shared library at `stardust/scripts/lib/` and the `package.json` that maps `#lib/*` onto it (the one import every
 * script uses for shared rules; skills/stardust/scripts/lib/README.md § Layout). Replaces the per-skill "copy the
 * scripts dir next to these" steps: one command, the library never forgotten.
 *
 * Usage: node skills/stardust/scripts/stage.mjs <skill…> | --all [--to stardust/scripts] [--from <plugin-root>]
 *   <skill…>   skills whose scripts/ dir to copy (deploy rollout qa …); --all copies every skill that ships scripts
 *   --to       destination scripts dir (default stardust/scripts); <to>/<skill>/, <to>/lib/, <to>/package.json
 *   --from     plugin root (the dir holding skills/ and .claude-plugin/); default: the tree this file lives in —
 *              required when running a project copy of this script
 *   --help     this text, before any I/O
 * Idempotent: files are overwritten in place (a file the plugin no longer ships is left; delete <to>/<skill>/ to reset);
 * an existing <to>/package.json keeps its other keys, only `type` and `imports["#lib/*"]` are set. Prints one line per
 * copied dir with its file count. Exit 0 ok · 2 usage (no skill, unknown skill, flag without value, no plugin root).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const header = src.match(/\/\*\*[\s\S]*?\*\//);
  console.log(header ? header[0].replace(/^\/\*\*\s*|\s*\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim() : 'Usage: node stage.mjs <skill…> | --all [--to <dir>] [--from <plugin-root>]');
  process.exit(0);
}

const usage = (msg) => { console.error(`stage.mjs: ${msg}\nUsage: node stage.mjs <skill…> | --all [--to stardust/scripts] [--from <plugin-root>]  (--help for details)`); process.exit(2); };

/** Parse argv: value flags (--to, --from), the --all switch, bare words are skills. */
export function parseArgs(args) {
  const o = { skills: [], to: 'stardust/scripts', from: null, all: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--all') o.all = true;
    else if (a === '--to' || a === '--from') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = v; i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else o.skills.push(a);
  }
  return o;
}

/** The plugin root this file lives in (skills/stardust/scripts/stage.mjs → ../../..), or null in a project copy. */
export function defaultPluginRoot(here = HERE) {
  const root = resolve(here, '..', '..', '..');
  return existsSync(join(root, '.claude-plugin', 'plugin.json')) && existsSync(join(root, 'skills', 'stardust', 'scripts', 'lib')) ? root : null;
}

/** Skills under <root>/skills/ that ship a scripts/ dir. */
export const skillsWithScripts = (root) => readdirSync(join(root, 'skills')).filter((s) => existsSync(join(root, 'skills', s, 'scripts')) && statSync(join(root, 'skills', s, 'scripts')).isDirectory()).sort();

const countFiles = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1), 0);

/** Write or update <to>/package.json so `#lib/*` resolves to <to>/lib/*; other keys of an existing file are kept. */
export function writeImportMap(to) {
  const file = join(to, 'package.json');
  let pkg = {};
  if (existsSync(file)) { try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch { pkg = {}; } }
  pkg.type = 'module';
  pkg.imports = { ...(pkg.imports || {}), '#lib/*': './lib/*' };
  if (!pkg.description) pkg.description = 'Written by stardust stage.mjs: maps the `#lib/*` import of every staged script onto ./lib/ (the shared rules). Not an npm package.';
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return file;
}

/** Copy the named skills' scripts and the shared library into <to>. Returns the lines it printed. */
export function stage({ skills, to, from }) {
  const lines = [];
  const dest = resolve(to);
  mkdirSync(dest, { recursive: true });
  for (const skill of skills) {
    const src = join(from, 'skills', skill, 'scripts');
    const out = join(dest, skill);
    // the stardust skill's own scripts/ holds lib/, which is staged once at <to>/lib/ (below), never as <to>/stardust/lib/
    const filter = skill === 'stardust' ? (p) => !(relative(src, p) === 'lib' || relative(src, p).startsWith(`lib${sep}`)) : undefined;
    cpSync(src, out, { recursive: true, force: true, filter });
    lines.push(`staged ${skill.padEnd(18)} → ${relative(process.cwd(), out) || '.'}/ (${countFiles(out)} files)`);
  }
  const libSrc = join(from, 'skills', 'stardust', 'scripts', 'lib');
  const libOut = join(dest, 'lib');
  cpSync(libSrc, libOut, { recursive: true, force: true });
  lines.push(`staged ${'lib'.padEnd(18)} → ${relative(process.cwd(), libOut) || '.'}/ (${countFiles(libOut)} files)`);
  lines.push(`wrote  ${relative(process.cwd(), writeImportMap(dest))} (#lib/* → ./lib/*)`);
  return lines;
}

let opts;
try { opts = parseArgs(argv); } catch (e) { usage(e.message); }
const from = opts.from ? resolve(opts.from) : defaultPluginRoot();
if (!from) usage('not inside a plugin tree — pass --from <plugin-root> (the dir holding skills/ and .claude-plugin/)');
if (!existsSync(join(from, 'skills', 'stardust', 'scripts', 'lib'))) usage(`${from} is not a stardust plugin root (no skills/stardust/scripts/lib/)`);
const available = skillsWithScripts(from);
const skills = opts.all ? available : [...new Set(opts.skills)];
if (!skills.length) usage(`name at least one skill or pass --all (available: ${available.join(' ')})`);
const unknown = skills.filter((s) => !available.includes(s));
if (unknown.length) usage(`no scripts/ dir for: ${unknown.join(', ')} (available: ${available.join(' ')})`);
for (const line of stage({ skills, to: opts.to, from })) console.log(line);
