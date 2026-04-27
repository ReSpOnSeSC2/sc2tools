<!--
Title format: conventional commits.
Examples:
  feat(stage-2.4): persistent /settings page
  fix(macro): chain-counted chrono for builds < 93272
  refactor(spa): extract SettingsBackupsPanel helpers
  docs(adr): record decision to keep build_definitions in Python
Allowed types: feat / fix / refactor / test / docs / chore / perf / style
-->

## What

<!--
One paragraph. What this PR changes from the user's perspective.
Link the stage / ticket if relevant (e.g. "Stage 2.4 of MASTER_ROADMAP.md").
-->

## Why

<!--
Why now, why this approach. Problem this solves. If this closes a roadmap
stage, name the stage. If it unblocks something downstream, name that too.
-->

## How tested

<!--
Concrete commands and outcomes — not "tested locally". Examples:

- `npm test` in stream-overlay-backend → 142 passing, 0 failing
- `pytest SC2Replay-Analyzer` → 89 passing
- Smoke test: booted backend, hit `/api/backups` → 8 snapshots returned;
  POST /api/backups/create + restore round-trip succeeded
- Manual: opened /settings in Chrome, edited mmr_target, hit Save,
  reloaded → value persisted
- Real-replay test on `C:\Users\…\Replays\Multiplayer\*.SC2Replay`
  (count + which folder)
-->

## Screenshots / recordings

<!--
Required for any UI change. Drag screenshots in here.
Before / after if a redesign.
For data-rendering changes, include a row of the actual rendered output.
-->

## Migration & rollback

<!--
Migration: what runs on the user's data (data/*.json, schema bumps,
backfill scripts). Forward AND backward tested on a copy of prod data?

Rollback: how to undo this PR if it breaks production.
For a single-file revert: `git checkout HEAD~1 -- path/to/file`.
For schema bumps: link to the down-migration script.
If no migration: write "n/a".
-->

## Definition-of-done checklist

- [ ] Conventional-commit title
- [ ] One concern per PR (no drive-by refactors mixed in)
- [ ] No file > 800 lines after this change (single-file SPA `index.html` excepted)
- [ ] No function > 60 lines, no class > 200 lines / 7 public methods
- [ ] Cyclomatic complexity ≤ 10 per function
- [ ] `ruff` / `mypy --strict` / `eslint` / `tsc --noEmit` clean
- [ ] Coverage gates pass (≥ 80 % Python, ≥ 70 % JS)
- [ ] Real fixtures over mocks; no synthetic timestamps in shipping code
- [ ] Logs grep-clean of PII (no battle_tags, opponent names, push tokens, refresh tokens at INFO level)
- [ ] Atomic file writes for any `data/*` mutation (write → fsync → rename)
- [ ] No new TODO/FIXME/HACK without a ticket reference
- [ ] CHANGELOG.md updated
- [ ] ADR added under `docs/adr/` if this is a non-trivial decision
- [ ] If touching the chrono macro engine: did NOT break the chain-counted fix (commits c728ab0, 4107efd) — test with a build < 93272 and a build ≥ 93272

## Notes for reviewer

<!--
Anything you want the reviewer to focus on.
Known limitations. Follow-ups you've already filed as tickets.
"Please pay extra attention to X." If nothing: delete this section.
-->
