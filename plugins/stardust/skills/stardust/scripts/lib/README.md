# Shared script library

One copy of every rule more than one stardust skill's scripts apply: EDS paths, names and the widget contract, kinds,
the dynamics taxonomy, and the resolver that finds a sibling skill's script in either layout. Pure ESM, no I/O at import.
Each file's header says what it owns and which consumers it replaced; the characterization test
(`../test/contracts-characterize.test.mjs`) pins every variant's output and the golden chain (`evals/golden/`) pins the
pipeline's bytes, so a change here is visible before it ships.

| file | owns |
|---|---|
| `paths.mjs` | the canonical delivered-path contract (`deliveredUrl`, `daPath`, `pathKey`, formerly `deploy/scripts/eds-path.mjs`) plus one named variant per consumer whose output differs (`treePath`, `rosterPath`, `pathSlug`, `sidecarName`, `sitemapKey`, `servedPath`, `safePath`, `documentPath`, `listingKey`/`listingUrl`, `chromeHrefKey`, `redirectKey`, `urlForm`) |
| `names.mjs` | `RESERVED`, `edsName`, `reservedStem`; the widget contract `widgetStem`, `widgetHref`, `widgetCodePath`, `pageWidgets`, `widgetLinks(html, { mount, base, dedupeBy })` |
| `kinds.mjs` | `CODED`, `CHROME_IDS`, `kindOf`, `isChromeName`, `QA_CHROME_PATHS`, `documentKind`, `META_BLOCKS`/`KEY_VALUE_BLOCKS`, `DEFAULT_CONTENT`, the kind enums (`SPEC_MAP_KINDS`, `SPEC_CATALOG_KINDS`, `ROLLOUT_KINDS`, `DYNAMICS_TARGETS`), `AI_EXCLUDE_DEFAULT` |
| `taxonomy.mjs` | dynamics `TAXONOMY` and the single `CLASS_NAMES` |
| `resolve.mjs` | `layout`, `sibling`/`siblingPath`/`loadSibling`, `lib`/`libPath` |

Centralise first, converge later: a variant keeps its consumer's current output until a deliberate commit removes its
`KNOWN_DIVERGENCE` rows from the characterization test and says why.

## Layout

Two layouts hold these scripts, and one import must work in both:

```
plugin tree                                   project copy (stage.mjs)
plugins/stardust/package.json                 stardust/scripts/package.json
plugins/stardust/skills/stardust/scripts/lib/ stardust/scripts/lib/
plugins/stardust/skills/<skill>/scripts/*.mjs stardust/scripts/<skill>/*.mjs
```

No relative specifier reaches `lib/` from both (`../../stardust/scripts/lib/` in the plugin tree is `../lib/` in the
copy), so every consumer imports the library through Node's package-level import map instead:

```js
import { pathKey } from '#lib/paths.mjs';
export { RESERVED, edsName } from '#lib/names.mjs';   // a one-line re-export, so a skill's own lib.mjs keeps its API
```

Node resolves `#lib/*` against the nearest `package.json` above the importing file: `plugins/stardust/package.json`
maps it to `./skills/stardust/scripts/lib/*`; `stage.mjs` writes `stardust/scripts/package.json` mapping it to
`./lib/*`. The alternative — a per-script bootstrap that probes two candidate directories and `await import()`s the
library — was rejected: it puts a candidate list and a top-level await in every consumer (the duplication this library
removes), and a static specifier is greppable and checked by `node --check`-plus-import in `../test/layout.test.mjs`.

What this means in practice:

- **Stage with `stage.mjs`**, never by hand: `node <plugin>/skills/stardust/scripts/stage.mjs deploy rollout qa` copies
  the named skills to `stardust/scripts/<skill>/` and ALWAYS `lib/` and the `package.json`. A hand-copied skill dir
  without them fails at import with `ERR_PACKAGE_IMPORT_NOT_DEFINED: Package import specifier "#lib/…"` — the fix is
  the `stage.mjs` line above.
- **Sibling skills' own scripts** (the diff skill's `live-session.mjs`, the rollout lint) are not in `lib/`; reach them
  with `resolve.mjs`: `const { openSession } = await loadSibling('diff', 'live-session.mjs')`. The resolver knows its
  layout from its own location, so the consumer carries no candidate list.
- **Layout check**: `node skills/stardust/scripts/test/layout.test.mjs` stages every skill into a temp project and
  runs each script's `--help` (which links its static imports) or imports it when it is a library, so a broken
  cross-skill path fails there, not in the field.
- The old entry points keep working for in-flight project copies: `deploy/scripts/eds-path.mjs` re-exports
  `paths.mjs`, `spec/scripts/lib.mjs loadSibling` still resolves.
