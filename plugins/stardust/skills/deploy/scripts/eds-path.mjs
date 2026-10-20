/**
 * skills/deploy/scripts/eds-path.mjs — the delivered-path contract for EDS, now owned by the shared library
 * (skills/stardust/scripts/lib/paths.mjs, imported as `#lib/paths.mjs`). This file stays as a re-export for one release so
 * in-flight project copies and the scripts that still look it up by path (localize-links, seed-redirects, spec-knowledge
 * via loadSibling, qa from-knowledge) keep working. Library, no CLI; pure, nothing runs on import.
 *   deliveredUrl(sourcePath) — the URL a source page is served at: segments sanitised, `.html` dropped, `/index` → `/a/`
 *   daPath(url)              — the DA document behind a delivered URL: `/a/` → `/a/index`, `/` → `/index`
 *   pathKey(path)            — the lookup key for matching links to pages (no query, `.html`, `/index` or trailing slash)
 */
export { deliveredUrl, daPath, pathKey } from '#lib/paths.mjs';
