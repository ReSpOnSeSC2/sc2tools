# Desktop recent games and import progress — ready for root review

Branch: codex/wave4-agent-dashboard, isolated worktree:
C:/SC2TOOLS/.worktrees/wave4-agent-dashboard.
Native implementation is frozen at f37c0a9d47de036b8918c0aaa6209d9b0261df78.
Main through guides #695 (3d965f36) is integrated at 58ee2302; additive root
changelog conflicts preserve all shipped entries. Read the exact full
agent-dashboard-games specification, both augments and howto in final-plan.json.

## Final behavior

- Every accepted upload emits a whitelisted canonical game summary; existing
  live-only check-in callbacks retain their scope. Account changes during HTTP,
  queued history writes or GUI delivery fence opponent/game metadata.
- A bounded background worker owns all history/state scans and durable JSONL
  writes. recent_games.jsonl retains 200 outcomes; first creation seeds the newest
  100 dated uploads without inventing game results or played dates. History
  bursts cannot evict the newest live game. Temporary disk failure retains
  pending rows and retries; old durable rows remain visible with an explanation.
- Real incremental QAbstractTableModel: eight columns, result pills, relative
  times/absolute tooltips, All/Uploaded/Problems/Skipped counts/date filters,
  collapsed imports, canonical analysis links, exact-file Explorer selection,
  Copy path/error and single/multi-failed retries. Unknown-date skip markers stay
  under All dates and are not double-counted with known timestamped rows.
- Dashboard Last game and locally tracked Today W-L/MMR; upload-time +N today,
  persistent Last upload, Failed24h and Waiting. Inventory already includes
  queued files, so Waiting takes max(queue, remaining) rather than adding twice.
  Net MMR never crosses an unknown rating, custom game or different ladder.
- Cached local import snapshots show phases/counts, five-minute EWMA and a
  minimum-sample ETA. Pause and connection holds exclude idle time. Organic
  startup and manual Re-sync both keep tracking if cloud job registration is
  offline or absent. Empty imports finish. Inventory/fsync never run on Qt;
  summary repaint is capped at four per second.
- Only this season asynchronously saves just that filter, preserving unrelated
  drafts. Reason/path retry clears only selected existing/non-pending cursor
  entries, rolls back on failed persistence and respects the active date filter.
  Both filtered marker formats are supported.
- Local every-game notifications are opt-in, deduplicated and exclude history
  imports/resumed games. Re-sync is in Settings Maintenance; Updates stays
  visible next to the sidebar version. README, changelogs and both full help
  articles explain actual behavior and local-data limits.

## Final verification

- Full Windows agent suite: 2,194 passed, 1 expected non-Windows skip (350.77 seconds).
- Final actual Qt/history/package-source regressions: 21 passed.
- After the final startup/marker corrections: 117 controller/import/all-queue/
  selective-retry tests passed (73.37 seconds).
- Post-build full web typecheck, strict help lint and all 72 help tests pass.
- Exact CI production environment build and every unchanged bundle budget pass:
  /app 235.1/240 kB; /help 151.3/185; /help/[slug]179.6/200. Logs are in apps/web/
  dashboard-web-build.log and dashboard-web-budget.log (ignored local artifacts).
- Normal unsigned PyInstaller build completed with a short workspace output
  (.tmp/pkg) to avoid the Windows Qt-resource path limit. Cache/temp stay under
  the worktree. No packaging source change or dependency addition was required.
- All 11 changed compiled modules match current source, including import_progress;
  the verifier fails closed. Proof: apps/agent/.tmp/dashboard-modules-proof.json.
- Actual unsigned executable passed its service-free offscreen Qt 6.12 diagnostic:
  all 5 pages, Dashboard/Recent/import, Streams and both check-in previews painted.
  Report: apps/agent/.tmp/dashboard-frozen-latest.json. Diagnostic mode does not
  bootstrap the runner, read user state, start workers or use network.
- Styled actual Qt screenshots were inspected at 1180x900 and 820x600:
  docs/screenshots/desktop-{dashboard-games,recent-games,import-progress,maintenance}[-small].png.
  Footer text and the native history arrow stay visible; the opponent column
  remains readable and the table scrolls at minimum width. Offscreen rendering
  does not certify actual game-foreground capture or Windows focus behavior.

## Delivery boundaries and limits

Draft-only delivery; root owns final review, main integration, CI/merge order and
coordinated release. Canonical version remains 0.19.0. No installer execution,
signing, tag, release or production operation occurred. Local native actions use
fakes in tests; screenshots use sample opponents, never private user games.
Today describes locally tracked game details (bounded history), while Synced
uses upload times; the UI/help make that distinction explicit. Seeded legacy
rows and unknown-date skips cannot honestly supply a full historical W-L.

Stream-title provider integration remains separately held after automatic
approval rejection; root has no human answer yet. Local-only helpers are at
2f511edc in wave4-stream-titles. No AI features or model API calls were added.
Root requests a read-only review of its frozen game-navigation source after
this draft is frozen and will provide that exact commit.

