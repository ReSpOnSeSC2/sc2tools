# Desktop recent games and import progress checkpoint

Branch `codex/wave4-agent-dashboard`, isolated worktree
`C:/SC2TOOLS/.worktrees/wave4-agent-dashboard`, based on main
`71d003376c8187d5cff126362e2a193b43b5c109`. Root explicitly assigned
`agent-dashboard-games` while stream-title provider integration awaits human
authorization. Read the full final-plan specification, both augments, folded
audit and howto. Root merged urgent Archon repair #696 as `72b345d0`; integrate
that newer main before the final PR.

## Implemented foundations — not yet wired into the main desktop window

- `recent_games.py`: accepted canonical ID and whitelisted CloudGame summary;
  own MMR only; private JSONL capped at 200 rows, first-start newest-100 dated
  cursor seeding, restart/deduplication and account-specific display. Seeded
  uploads do not invent replay results or dates. Existing Windows sharing-lock
  replacement retry is reused; failed durable writes keep disk and visible rows.
- Local Today math uses the actual replay date in the local timezone and only
  valid adjacent same-region/same-race ladder ratings. Missing MMR, custom games
  and region/race switches break the chain. Upload-time counts remain separate
  from played-time W–L. Skipped markers have plain-English grouped explanations
  and only the four specified retryable reasons are marked retryable.
- `import_progress.py`: five-minute time-weighted EWMA; ETA hidden until at least
  three positive samples, five processed replays and 15 elapsed seconds.
- `ImportController.snapshot()` and `on_change` expose cached local counts,
  Scanning/Importing/Done phases, rates and ETA without disk/network in the read.
  Callbacks run outside its lock; existing cloud request bodies are unchanged.
- `ui/recent_games.py`: real QAbstractTableModel/QTableView with eight requested
  columns, absolute tooltips, status/date filter counts, collapsed history group,
  game activation, qualified-path/error actions and multi-select Retry failed.
  Updates use insert/remove ranges rather than model resets, including at cap.

## Local evidence

- Store/Today/summary/import progress plus all existing ImportController checks:
  **45 passed**.
- Real offscreen Qt component tests: **5 passed**. They exercise 500 incremental
  inserts without resets, preserve a persistent index while trimming the cap,
  check columns/tooltips/group/filter behavior and invoke menu/activation signals.
- All native component actions use fakes; browser/network calls are prohibited.
  No Explorer, provider, installer, release, tag or production operation ran.
- First 205-row writer stress exposed a real transient Windows replace lock.
  Reusing the existing bounded replacement helper fixed it; no test weakened.

## Remaining full pack requirements

1. Wire UploadQueue `on_game_synced(path, summary)` for both batch/history and
   live/single accepted paths. Queue local persistence on its own bounded worker;
   do not add fsync or a whole-state scan to the Qt or upload thread. Preserve
   existing live-only check-in callback semantics, upload admission and archives.
2. Route metadata/initial history/import snapshots over GuiUI signals; replace the
   main window's old QTableWidget with this component. Keep summary stats refresh
   at most four per second. Preserve all earlier preview/recovery/settings fixes.
3. Last game, Today, Synced +N today, persistent relative Last upload, Failed24h
   action and Waiting = queue plus remaining inventory. Legacy metadata cannot
   honestly produce a full W–L; make that limit visible instead of inventing data.
4. Import card/progress for organic history and manual Re-sync, rate/ETA/phase,
   Pause, Only this season, View on website. Disk inventory stays off Qt. Pause
   and connection holds must hide misleading ETA/rate and use the existing lane.
5. Narrow reason/path retry under queue/state locks, requeue only selected failed
   files or one specified reason; active date filter still applies. Never clear
   unrelated uploaded markers. Explorer reveal must select the exact file.
6. Complete skip/date behavior: legacy skip markers have unknown dates; do not
   pretend they occurred today. Add actual timestamped new skip rows as appropriate.
7. Every-game opt-in game-summary notification (currently no general notification
   preference exists); maintenance/update placement augments; README, agent/root
   changelogs, two help leaves `desktop-app-recent-games` and `desktop-app-import`.
8. Meaningful queue/runner/full-window/actual native checks, full agent suite,
   package diagnostic, help index/types/lint/budgets, latest main integration,
   fully described attached draft PR. No shipping claim before those are complete.

Stream-title integration is independently held after automatic approval rejection.
Its local-only helpers are clean at `2f511edc` in `wave4-stream-titles`; do not
work around that hold. Root owns final merges. No AI features/API calls or new
infrastructure; canonical release bump/tag/signing/installation remain manual.
