# Listings — metadata contract and query-index

Blocks that LIST other pages (directories, news/event feeds, "related" rails) read an EDS
**query-index** (a published JSON of pages with per-page properties) — or, where the source curates
the list, a curated sheet — never frozen cards (triage.md rule 10).

## Why it is a PRE-IMPORT gate

What a dynamic block can show is bounded by what each page emits, and an index row carries only
page-intrinsic DOM **or** authored metadata. The metadata a block needs must be decided **before**
the batch import — emitting it per page at write time is one extra row; retrofitting it across
thousands of published pages is a second migration. `stardust/dynamic-features.md § Listings
contract` records it; `helix-query.yaml` at the EDS project root is authored from the same contract.

## What a row can carry

1. **Tier 1 — page-intrinsic DOM** (`h1`, `og:image`, authored links) via CSS selectors in
   `helix-query.yaml`. Zero content change. Meaningful internal links become free facets.
2. **Tier 2 — page metadata** (dates, locations, categories) emitted as `<meta name="…">` through
   each page's metadata block at author time. A metadata row `KEY | VALUE` renders to
   `<meta name="<key lowercased>">`: single-token capitalised keys (`PublishDate` →
   `publishdate`), selectors `meta[name="publishdate"]`, dates as ISO `YYYY-MM-DD`.
3. **NOT relationships.** A flat index cannot express many-to-many. Those need an explicit join
   field in metadata on one side, and the related items must themselves be indexed pages. Without
   that the block stays `static-snapshot` — record it, do not fake it.

## Getting an index at all — `helix-query.yaml` first

`/query-index.json` answering 404 means the project ships no `helix-query.yaml` (the demo
boilerplate does not) — a code-branch authoring gap, never a configuration-service problem. The
first remedy, in this order:

1. Author `helix-query.yaml` at the code-branch root: the delivered content roots into
   `target: /query-index.json`, chrome and search documents excluded.
   ```yaml
   version: 1
   indices:
     default:
       include:
         - '/**'
       exclude:
         - '/nav'
         - '/footer'
         - '/**/nav*'
         - '/**/footer*'
         - '/fragments/**'
         - '/drafts/**'
         - '/search'
       target: /query-index.json
       properties:
         title:
           select: head > meta[property="og:title"]
           value: attribute(el, 'content')
         description:
           select: head > meta[name="description"]
           value: attribute(el, 'content')
         image:
           select: head > meta[property="og:image"]
           value: match(attribute(el, 'content'), 'https:\/\/[^/]+(\/.*)')
         lastModified:
           select: none
           value: parseTimestamp(headers['last-modified'], 'ddd, DD MMM YYYY hh:mm:ss GMT')
         robots:
           select: head > meta[name="robots"]
           value: attribute(el, 'content')
   ```
   Per content type add its Tier-2 fields (`publishdate`, `category`, …) from § Listings
   contract; a `text` property (`select: main`, `value: textContent(el)`) when search excerpts
   are wanted; a `lang` property per locale tree (a scoped index per tree, locale-trees.md).
2. Commit and push the code branch (deploy's Code stage).
3. Make sure the pages are published LIVE — the indexer reads live-published pages only; a
   preview-only tree gives an empty index.
4. Poll `GET <origin>/query-index.json` no more often than every 5 s, for at most 10 minutes,
   until it answers 200 with `total` at the expected page count (re-publish one page to nudge an
   index that stays at `building`). The total goes into the ledger detail.

No admin configuration-service write is part of this — a 403 from `admin.hlx.page/config/…`
with the migration token is expected and is not a blocker. A recorded hands-off run probed that
service, concluded "no index can be configured" and built a sheet-backed interim index while
the fix was one committed yaml file. The sheet-backed index (rows synced with
`scripts/sync-sheets.mjs`, the block reading the sheet's JSON) is the fallback ONLY when the
code branch is not writable, recorded `interim` with the owner decision named.

## Mechanics

- Scoped indexes: include globs + `target` per index; exclude chrome and search documents; a
  `lang` property per locale tree; a `text` property when search excerpts are wanted.
- **The index builds from the PUBLISHED tree.** A preview-only rollout has an empty index;
  `POST /index/…` answering "requested path returned a 301 or 404" means "not published", not
  "bad selector". Publish per page as a delivery-loop step, then poll `total` until it settles.
- **Publish the index early.** It is the cheapest "is this path ours" oracle and silences library
  code that expects it.
- Localise internal links first, or the index captures source-site URLs as paths.

## Block contract

Runtime-sourced (triage.md rule 10): authored rows are the head, the UI labels and one query row per
key (`source`, `filter`, `sort`, `offset`, `limit`); the block fetches, filters, sorts, pages and
renders the cards. A grouped listing is one block per group, each with its own query. For
non-rendering crawlers the page carries an authored summary of what it lists; the AI-readability
`code` metric excludes the list blocks (`--exclude-blocks`), `strict` reports their cost.

**Verify.** A `runtime-list` parity row per list (parity-report.md); a newly published page appears
in every list whose rule admits it, with no document edited.
