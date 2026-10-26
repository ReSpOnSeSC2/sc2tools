# Analyzer current-season default — 2026-10-26

The owner requested Auto-track current season as the default date range on
Opponents. The shared analyzer default is now `current_season`, so fresh views,
Reset to defaults and removing a date chip resolve the live season catalog.
The picker says Auto-track current season and the summary identifies its
resolved season with `(auto)`. Numbered seasons remain pinned.

Existing valid localStorage choices, explicit URL filters, custom dates and
saved/default views retain their existing precedence. Stored choices have no
provenance that distinguishes an old default from an intentional patch choice;
this change does not overwrite them. Reset opts an existing view into Auto.
The Today Win rate card already shares the default constant and now starts on
Auto too; its independent saved range remains independent.

Validation together with the separate Macro graph inspection correction:

- 202 focused tests across 15 suites; 35 Help tests across three suites.
- Whole-web types before and after production build; strict changed-file lint
  with zero warnings. UI rules 19/19, ratchet 1,699 files/642 existing entries.
- Help index: 91 articles; two deterministic renders match the committed index,
  no generated index changes.
- Build `XRIBFiZxEZrYKi-dSwZtl`: 144 pages, all 81 route budgets passed. This
  build preceded the final game-page Help wording/date update for the separate
  graph fix; exact-head CI must compile that final wording before merge.
- The canonical 40 engine inputs, bundle d27b37abb9997712, four strict sample
  payloads and nine retained runtime files were admitted unchanged before/after
  build. No assets generated, downloaded, copied or pruned.
- Provider regressions cover a fresh Opponents view through season 68 to 69,
  Reset persistence across reload, and keeping an explicit season 68 pinned.
  Existing URL, saved-view, custom-date and patch-preset tests remain intact.

The initial local test attempt was cancelled after its new mocked season hook
returned a new response object on every render. The fixture now retains stable
response identity until the catalog changes. Two old dashboard assertions were
updated for the intentional new default; the original log is preserved.

Local evidence: `.cache/analyzer-behavior-fix/` in the retained
`wave3-guides-expansion` worktree. Browser proof and remote exact-head delivery
are still pending at this source checkpoint. No data migration, replay
recomputation, version/tag change or production preference mutation.

Exact-head CI on the stacked graph source exposed one additional existing
phone Reset test comparing a module-time `until` snapshot to the new rolling
season window. All fields matched; `until` advanced by 596 ms. Its original
file/hash and bounded first-party failure evidence are retained under
`mobile-reset-ci-before/`. The test now retains the complete default-field
comparison and checks that the resolved end lies between the actual Reset
start/end times; all focus, disabled-button and Done assertions remain.
