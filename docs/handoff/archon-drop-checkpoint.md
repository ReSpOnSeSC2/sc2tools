# Archon Drop classification repair

Urgent user report: Blackrock LE (2026-10-20, win, 11:15) and Washout LE
(2026-10-15, loss, 15:12) were labelled PvZ Archon Drop. Actual replay files and
game IDs were not available locally, so these two games have not been rerun.
No saved game records or production data are changed by this branch.

## Scope and evidence

- The canonical PvZ Stargate branch had no Warp Prism requirement. The DT branch
  allowed a Prism until 9:00 and did not require an actual Archon.
- Before the repair, the new regression matrix produced 26 failures and 42 passes.
- Both labels now require a non-hallucinated Warp Prism completed at or before
  360 seconds. The Stargate branch retains two real Archons by 9:00 and Templar
  Archives; it also uses the existing first-tech Stargate predicate. The DT branch
  retains three real DTs and Dark Shrine/Robotics tech, and requires at least one
  observed real Archon by 9:00. No other opener thresholds are changed.
- Unit counting uses the shared prerequisite-aware real-unit helper. A Prism row
  without Robotics Facility, or hallucinated Prism/Archon rows, cannot supply proof.
- Raw extractor unit timestamps are appearances/completions. API
  `eventsToStartTime` rewinds timeline display rows and preserves `complete_time`;
  those display timestamps are not classifier inputs. Existing extractor/log
  timestamps have whole-second precision; this repair preserves that timebase.
- The agent imports the canonical engine. The Pyodide payload packages the same
  engine. Readable definitions and the generated web/API guide catalogs must be
  regenerated together and expose the 6:00 completion deadline.
- Audit found no generic opponent branch emitting either Archon Drop label.
  Existing opponent Protoss taxonomy remains stable; custom user rules remain
  independent and unchanged.

## Verification checkpoint

Local final verification:

- Full replay-engine suite: **1,018 passed, 4 skipped** (10.59 s).
- Desktop/Instant Analysis fixture parity: **60 passed** (24.36 s), including
  both installed and source data views.
- Built browser engine: **9 passed, no skips**; verified archive
  `a64296c79faab4aa`, actual Pyodide execution of both openings against the
  shared raw-event matrix, and every fixture/perspective matched CPython goldens.
- Web definitions and guide catalog parity: **24 passed**. Regenerated all
  188 engine descriptions and the 195-entry API guide catalog with unchanged names.
- API per-game compute: **56 passed**, including late Prism completion versus
  early rewound display start. Touched API test lint has no errors and the same
  five existing long-function warnings as before.
- `git diff --check` passed. Browser engine artifacts/goldens/logs are local and
  ignored, not checked-in generated binaries.

The first full Python attempts encountered sandbox temporary-directory failures,
and one permission review timed out. Reruns with isolated workspace temp paths
and approved helper-process execution passed; no assertions were weakened.

Existing saved labels will need normal replay reanalysis to apply the corrected
detector; screenshots alone cannot establish whether these two reported games
meet the new condition. No reanalysis or production write was performed here.

## Main integration

Integrated main `71d003376c8187d5cff126362e2a193b43b5c109`, including admin
history #692, replay workspace/clock #693 and desktop preview #694. Only the two
Unreleased changelog insertions conflicted; both sides' entries were preserved.
The API completion projection and both completion-clock regressions remain intact.

Revalidation after integration: full engine **1,018 passed, 4 skipped**;
desktop Instant Analysis + actual card preview/runner **87 passed**; built
Pyodide and all CPython goldens **9 passed, no skips**; web catalog + replay
page/stage integration **72 passed**; API compute **56 passed**. Full web and
API typechecks passed. Help index regeneration left no content diff. The initial
repair head passed every GitHub workflow and Vercel; final merged-head CI is
required again before the parent merges #696.

The later all-preset runtime policy work belongs to the API agent and must retain
these defaults. Stream-title automation remains queued in its isolated worktree.
No release, version bump, tag, signing, installation or production operation is
part of this repair.
