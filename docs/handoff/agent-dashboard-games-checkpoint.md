# Desktop recent games and import progress checkpoint

Isolated branch `codex/wave4-agent-dashboard`, worktree
`C:/SC2TOOLS/.worktrees/wave4-agent-dashboard`. Original base main
`71d003376c8187d5cff126362e2a193b43b5c109`; root merged the urgent Archon repair
#696 and newer work since. Fetch now reports main `939964979c1374b060fc44e6846360bdba65760b`;
integrate before the final draft. Read the exact `agent-dashboard-games` spec,
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
- Re-sync moved to Settings Maintenance; Check for updates sits beside the
  sidebar version. README, both changelogs and the two complete help leaves
  `desktop-app-recent-games` and `desktop-app-import` describe actual behavior.

## Verification so far (pre-integration)

- Full affected dashboard/queue-callback/import/controller/settings/status scope:
  **111 passed** in 17.12 seconds (`apps/agent/dashboard-focused-tests.log`).
- Earlier queue hook plus all existing queue tests: **70 passed** before the
  final retry/owner additions. Full agent suite must run after integration.
- Earlier foundation/state/native checks: 89 passed; current targeted Qt/runner/
  retry/import suite includes meaningful async-save, owner-change, burst-coalescing,
  exact-file arguments, unknown-date filters and offline-zero regressions.
- Native action tests use fakes, not system Explorer/browser/provider calls.
  No installer, sign, release, tag or production operation ran.

## Remaining before a draft PR

1. Integrate latest origin/main, preserve additive shared changes, regenerate
   help index; run help lint/types/tests and affected native checks again.
2. Review changed source for runtime lifecycle/edge cases. Run full agent suite
   and actual unsigned frozen package diagnostic. Capture and inspect actual
   offscreen Dashboard/Recent/Settings screenshots; fix geometry or copy issues.
3. Commit explicit paths, push and create a fully described attached **draft**
   PR. Report exact head, complete test/package evidence and truthful limitations.
   Root owns final review/integration/merge; no canonical version bump or tag.

Stream-title provider integration remains independently held after automatic
approval rejection. Local-only helpers are clean at `2f511edc` in
`wave4-stream-titles`. No human answer has been relayed, so do not retry/bypass
that hold. No AI features/API calls or new infrastructure.
