# Desktop recent games and import progress checkpoint

Isolated branch `codex/wave4-agent-dashboard`, worktree
`C:/SC2TOOLS/.worktrees/wave4-agent-dashboard`. Original base main
`71d003376c8187d5cff126362e2a193b43b5c109`; root merged the urgent Archon repair
#696 and newer work since. Main `939964979c1374b060fc44e6846360bdba65760b` is
integrated at `043609d62e1659e2c180ee4cdaea234b156de4ad` (additive changelog
conflicts only; all entries preserved). Read the exact `agent-dashboard-games` spec,
both augments, folded audit and howto in final-plan.json.

## Implemented

- Accepted canonical ID plus whitelisted CloudGame summary on every successful
  queue path. Existing live-only check-in callbacks retain their scope. Callback
  failures cannot repeat accepted uploads; an account change during the request
  fences local metadata, and delayed GUI/disk snapshots also verify the owner.
- `recent_games.jsonl` retains 200 private local outcomes; first creation seeds
  the newest 100 dated cursor uploads without inventing game metadata. A bounded
  history worker owns all JSONL/state scans and durable writes; history bursts
  cannot evict the latest live game. Failed writes retain prior durable rows,
  show an explanation and keep a bounded background retry.
- Real QAbstractTableModel/QTableView uses incremental insert/remove ranges,
  coloured result pills, eight requested columns, absolute time tooltips,
  collapsed history imports, All/Uploaded/Problems/Skipped counts/date filters,
  canonical game activation, exact-file Explorer selection, path/error copying,
  single and multi-failed retry. Unknown-date legacy skip groups are excluded
  from date-filtered views and not counted twice with known local rows.
- Last game, locally tracked Today W-L and adjacent same-region/same-ladder-race
  MMR math; upload-time Synced +N today, persistent relative Last upload,
  Failed24h action and Waiting. `count_pending` already includes queued files,
  so Waiting uses max(queue, remaining inventory) instead of double-counting.
  Metadata limits are visible rather than inventing an all-history W-L.
- Cached ImportController snapshots/signals, Scanning/Importing/Done and UI hold
  phases, five-minute EWMA with minimum-sample ETA, Pause, Only this season and
  website actions. Manual Re-sync shows determinate progress below the cloud
  threshold and while cloud reporting is offline; zero finishes. Holds exclude
  idle time from rate samples. Inventory/fsync stay off Qt and summary repaint
  is throttled at four per second.
- Reason/path retries clear only chosen existing, non-pending cursor entries;
  durable failure rolls them back. Saved date filters still apply. Only-this-
  season saves that filter asynchronously without saving unrelated form drafts.
- Opt-in local every-game result notifications default off, suppress history and
  resumed outcomes and deduplicate game IDs. No provider publication is involved.
- Re-sync moved to Settings Maintenance; Updates sits beside the
  sidebar version. README, both changelogs and the two complete help leaves
  `desktop-app-recent-games` and `desktop-app-import` describe actual behavior.

## Verification

- Integrated full native suite: **2,194 passed, 1 expected non-Windows skip** in
  350.77 seconds (`apps/agent/dashboard-full-tests.log`).
- After the final visible-label, native palette-arrow, minimum-column width and
  plain-text notification fixes: **21 passed**, covering actual Qt, packaged
  diagnostic and real worker recovery from a temporary history-write failure.
- Full web typecheck, all **72 help tests**, and strict lint pass. Final updated
  article/index checks pass **24 tests**, generated index remains current.
- Actual styled Qt windows captured and inspected at 1180×900 and 820×600 under
  `docs/screenshots/desktop-{dashboard-games,recent-games,import-progress,maintenance}[-small].png`.
  Updates stays visible beside a long development version; the native history
  arrow uses the text palette; the opponent column stays readable with horizontal
  scrolling at the minimum window width. No real game foreground behavior is
  claimed from offscreen rendering.
- Initial unsigned PyInstaller bundle built successfully. Comparing compiled
  module signatures against current source correctly found one stale module
  after the late table fix. A fresh final bundle is building in
  `apps/agent/.tmp/dashboard-dist-final`, log `dashboard-package-final.log`.
  Do not claim exact-source frozen success until comparison and diagnostic pass.

- Full affected dashboard/queue-callback/import/controller/settings/status scope:
  **111 passed** in 17.12 seconds (`apps/agent/dashboard-focused-tests.log`).
- Earlier queue hook plus all existing queue tests: **70 passed**; the complete
  integrated suite above also covers the final retry/owner additions.
- Earlier foundation/state/native checks: 89 passed; current targeted Qt/runner/
  retry/import suite includes meaningful async-save, owner-change, burst-coalescing,
  exact-file arguments, unknown-date filters and offline-zero regressions.
- Native action tests use fakes, not system Explorer/browser/provider calls.
  No installer, sign, release, tag or production operation ran.

## Remaining before a draft PR

1. Finish fresh unsigned frozen package, compare every changed compiled module
   against source and run the offline diagnostic. It now paints Dashboard,
   Recent games/import, Streams and both check-in previews without services.
2. Run the exact production web build/budgets for the additive help content after
   coordinating the shared browser-engine cache with the Studio agent.
3. Commit explicit paths, push and create a fully described attached **draft**
   PR. Report exact head, complete test/package evidence and truthful limitations.
   Root owns final review/integration/merge; no canonical version bump or tag.

Stream-title provider integration remains independently held after automatic
approval rejection. Local-only helpers are clean at `2f511edc` in
`wave4-stream-titles`. No human answer has been relayed, so do not retry/bypass
that hold. No AI features/API calls or new infrastructure.
