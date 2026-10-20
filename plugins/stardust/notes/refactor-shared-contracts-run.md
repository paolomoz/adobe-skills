# Shared contracts refactor — run log

Hands-off run started 2026-10-20 evening from `plugins/stardust/notes/refactor-shared-contracts-plan.md`.
One entry per step: started / done / evidence / deviations. Site names appear only here as local project
dir names for the replay set (this file is the audit trail; it never becomes skill prose).

Replay set (local project dirs): `/Users/paolo/stardust/2026-10/sdt-servicenow`, `/Users/paolo/stardust/2026-08/walgreens`,
`/Users/paolo/stardust/2026-08/sparebank1-redesign`, `/Users/paolo/stardust/2026-09-24-next/westerndigital-1`,
`/Users/paolo/stardust/2026-09-24-next/redballtennis-1`; live once: `/Users/paolo/stardust/migrate-heathrowairport`.

Baseline worktree (pre-refactor, pinned to origin/main at start): `/Users/paolo/stardust/source/201026/skills-baseline`.
Eval spend cap: $500. PRs: open against adobe/skills main, stacked refactor/0-prep → 1-lib → 2-drift → 3-model.

## Log

### Phase 0 — started
- plan + run log committed on `refactor/0-prep` (320f8bcb); baseline worktree created at 1af9b4b9; `caffeinate -dims` running.
- three parallel workstreams started: (1) characterization tests → `skills/stardust/scripts/test/contracts-characterize.test.mjs`;
  (2) golden chain `evals/golden/` + offline field replays into `../replay-baseline/` from the baseline worktree, one live
  spec+dynamics run on the airport project; (3) three new evals + `pre-refactor` baseline runs from the baseline worktree
  (hard cap for this step $220 of the $500).
- rule for this phase: no script edits in the EDIT worktree until (1) and (2) have produced their expected tables.
### Phase 0 step 2 + 4 — done
- `evals/golden/` committed: 9-step chain (migrate 3-page fixture → inventory → blocks → plan → delivery-lint; dynamics-plan; spec-knowledge), 49 expected files, fixed-clock preload, `golden.test.mjs` ~0.4 s, two consecutive runs identical. Left out (network/Playwright): spec-inventory/fetch/links, dynamics-detect, rollout deploy/verify.
- field replay baselines under `../replay-baseline/` from the baseline worktree: five offline projects ran (one dynamics-only), the live airport run ran spec-inventory/fetch/parse + dynamics-detect (headless hit redirect loops; `--headed` tier succeeded, 14 findings → 14 plan rows). All exit 0. Local only.
### Phase 0 step 1 — done
- `contracts-characterize.test.mjs` committed: 20 checks, 1.1 s, 102 KNOWN_DIVERGENCE rows (path-key 35, served-url 25, tree/DA/sidecar 11, widget-stem 9, chrome 7, class-label 2, kind-enum 13). Key facts for Phase 1: the nine path normalisers disagree on query, hash, case, `.htm` and host handling; `header` is chrome in rollout/spec/ai-readability but not in qa's default or delivery-lint; rollout's widget id strips only lowercase `.html`.
- step 3 (evals + baseline runs) still running in the baseline worktree.

### Phase 1 — started on `refactor/1-lib` (from 0-prep @ characterization commit)
- policy: centralise first, converge later. The library exposes the current variants by name/option so golden stays byte-identical and KNOWN_DIVERGENCE stays equal, EXCEPT a short whitelist of unambiguous bugs converged in this PR, each removed from KNOWN_DIVERGENCE deliberately and listed in the PR body: widget-stem `.html` case/`.htm` handling, the two class-label copies, qa/rollout trusting any href as a widget.
### Phase 0 step 3 — done
- three new evals committed on `refactor/0-prep` via the `skills-prep` worktree (`deploy-triage-widget`, `dynamics-target`, `spec-kinds`; 7 artifact-judged criteria each); runner SDK bumped to ≥ 0.3.304 (the bundled CLI rejected the environment's fast model).
- baseline label `pre-refactor` (plugin = baseline worktree, N=3, sessions on the environment's fast model — post-refactor runs must use the same): dynamics-target 95.0 (target_column_present 2/3), spec-kinds 100.0, deploy-triage-widget 93.3 (hero_is_block 1/3: two runs read D1 "no repeating units → default content" and made the hero default content although the same paragraph says heroes stay blocks — a real wording divergence for `eds-model.md` § Unit of UI). Spend $11.46 of the $500 cap. The `decided_out` criterion was re-scoped mid-baseline (hands-off runs may not set decided-out on an assumption) and the three run snapshots re-judged; both labels will face the re-scoped rubric.
- not runnable (no fixture, none invented): ai-readability, ew-editability, migrate-incremental.
- Phase 0 complete except PR opening (done with the stack at the end of the run).
- PR 0 opened: https://github.com/adobe/skills/pull/461 (`refactor/0-prep`, base main).
### Phase 1a — done (committed on refactor/1-lib)
- `skills/stardust/scripts/lib/{paths,names,kinds,taxonomy,resolve}.mjs` + README; `#lib/*` subpath imports via `plugins/stardust/package.json` (plugin tree) and the `stardust/scripts/package.json` that `stage.mjs` writes (project copy). `stage.mjs <skill…>|--all` replaces the prose copy steps; `layout.test.mjs` stages every skill and runs each CLI's `--help` from the copy (82 CLIs, 33 libraries, 9 skipped for playwright/pngjs).
- rollout swapped (lib re-exports; inventory/assemble/delivery-lint/publicUrl on named path variants); `deploy/eds-path.mjs` is a re-export; the two CLASS_NAMES copies are one.
- KNOWN_DIVERGENCE 102 → 96, all six removals in the whitelist. Golden byte-identical. 67/67 tests, lint exit 0.
- deviation: layout.test found `qa/scripts/checks/{ai-readability,editability}.mjs` importing `../../../deploy/scripts/…`, which resolves only in the plugin tree — fixed via `loadSibling`. Field bug, pre-existing.
### Phase 1b — started: three parallel swaps {deploy, diff, extract} / {qa, spec} / {migrate, replica, reskin} + prose copy steps and the CLAUDE.md bullet

### PAUSE — 2026-10-20, owner's request (other developers' changes land first)
State at pause:
- PR 0 open: https://github.com/adobe/skills/pull/461 (`refactor/0-prep`, complete; may need a rebase once the other changes merge).
- `refactor/1-lib` pushed to `fork` (no PR). Commits: 66afaea9 Phase 1a complete (lib, stage.mjs, layout test, rollout swap) and 1c72f6da **WIP** Phase 1b partial. The WIP commit is not reviewable as-is; squash or reword before opening PR 1.
- Phase 1b status per workstream when stopped: {qa, spec} in its final sweep — swaps done, verify the report-level checklist (content.mjs widgetLinks via `#lib/names`, META_BLOCKS, listingKey/listingUrl, QA_CHROME_PATHS, AI_EXCLUDE_DEFAULT, from-knowledge static paths import; spec lib re-exports CODED/CHROME_IDS/loadSibling, redirectKey, SPEC_MAP_KINDS; spec SKILL.md copy step → stage.mjs) and the qa `.htm` whitelist rows; {migrate, replica, reskin + CLAUDE.md/AGENTS.md} mid-way — CLAUDE.md/AGENTS.md bullet already rewritten, replica (11 files) and reskin (5) candidate lists partly swapped, migrate (1 file) started; the whitelist rows for migrate `/a/b.html`, `/nav` not yet removed; {deploy, diff, extract} NOT started (no edits).
- Green at pause: golden byte-identical (316 ms), characterization all checks passed, lint exit 0, 67/67 runnable tests.
- Worktrees: `skills` (refactor/1-lib), `skills-prep` (refactor/0-prep), `skills-baseline` (detached pre-refactor main, with the runner SDK bump and eval copies, uncommitted). `../replay-baseline/` holds the local field-replay baselines. caffeinate stopped.
- Eval spend so far: $11.46 of $500.
Resume: `git fetch origin && git rebase origin/main` on 0-prep then 1-lib (expect conflicts only if the other developers touched the same scripts); re-run golden + characterization + layout tests; finish the three Phase 1b workstreams from the checklist above; then Phase 2 (drift lints) and Phase 3 (eds-model.md) per the plan.
