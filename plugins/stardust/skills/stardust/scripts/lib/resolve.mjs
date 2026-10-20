/**
 * skills/stardust/scripts/lib/resolve.mjs — find a sibling skill's script, or a library file, from either layout. Library:
 * no I/O at import (the file-system probes run when a function is called). Import as `#lib/resolve.mjs`.
 *
 * Layouts (README.md § Layout): the plugin tree keeps this library at `skills/stardust/scripts/lib/` and a skill's scripts
 * at `skills/<skill>/scripts/`; a project copy (stage.mjs) keeps it at `stardust/scripts/lib/` and each skill at
 * `stardust/scripts/<skill>/`. The library's own location tells which layout it is in, so a consumer never carries a
 * candidate list of its own. Owns the layout knowledge; replaces spec lib.mjs loadSibling's lookup and the twelve `['../../diff/scripts/live-session.mjs',
 * '../diff/live-session.mjs']` lists in replica and reskin (they swap to `sibling()` in later commits).
 *
 *   layout()               'plugin' | 'project'
 *   siblingPath(skill, f)  absolute path of skills/<skill>/scripts/<f> (plugin) or stardust/scripts/<skill>/<f> (project); null when absent
 *   sibling(skill, f)      its file: URL for `import()`; throws naming both looked-up places and the stage.mjs line that fixes it
 *   loadSibling(skill, f)  `import(sibling(skill, f))`
 *   lib(f), libPath(f)     this library's own file as an import URL / path (for callers that cannot use `#lib/*`)
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SKILLS = resolve(LIB_DIR, '..', '..', '..'); // skills/            (plugin tree)
const PROJECT_SCRIPTS = resolve(LIB_DIR, '..');           // stardust/scripts/  (project copy)

/** Which layout this library sits in: a plugin tree has `skills/stardust/scripts/lib` three levels up from `skills/`. */
export const layout = () => (existsSync(join(PLUGIN_SKILLS, 'stardust', 'scripts', 'lib', 'resolve.mjs')) && existsSync(join(PLUGIN_SKILLS, 'stardust', 'SKILL.md')) ? 'plugin' : 'project');

/** The two places a sibling skill's script can be, in lookup order. */
export const siblingCandidates = (skill, file) => [join(PLUGIN_SKILLS, skill, 'scripts', file), join(PROJECT_SCRIPTS, skill, file)];

/** Absolute path of `<skill>/scripts/<file>` in whichever layout holds it; null when neither does. */
export const siblingPath = (skill, file) => siblingCandidates(skill, file).find((p) => existsSync(p)) || null;

/** Import URL of a sibling skill's script; throws a message that names the fix when it is missing. */
export function sibling(skill, file) {
  const p = siblingPath(skill, file);
  if (!p) {
    throw new Error(`${skill}/${file} not found (looked in ${siblingCandidates(skill, file).join(' and ')}): stage the ${skill} skill next to these scripts — node stardust/scripts/stardust/stage.mjs ${skill}`);
  }
  return pathToFileURL(p).href;
}

/** `import()` of a sibling skill's script. */
export const loadSibling = (skill, file) => import(sibling(skill, file));

/** A file of this library as a path / import URL — for a caller outside the `#lib/*` map (a one-off `node -e`, a test). */
export const libPath = (file) => join(LIB_DIR, file);
export const lib = (file) => pathToFileURL(libPath(file)).href;
