# Active upgrade checkpoint — 2026-10-25

Reconcile the older HANDOFF.md and final-plan.json with this checkpoint. Continue
implementation, tests, PR repairs and green-check squash merges. The overall
roadmap remains incomplete; docs/SETUP_GUIDE.md is still required at the end.

## Latest owner corrections and shipped work

- Keep the live dossier order: Brief, Tendencies, Timings, History, Ladder,
  Identity. Replay History stays above Notes. Withdrawn PR739 must not return.
- PR740 already shipped seven-minute PvZ Void Ray/Phoenix opening criteria.
  Do not reanalyze production games without authorization.
- PR747 already shipped the passive recorded-composition scroll correction.
- PR753 merged at cf25bc8883858908f4a0b1591a83c39b8805fd5f: native report X and
  minimize use the same nonactivating input proxies as the scouting icon. All
  exact-head checks and Windows/compact/transparency proofs pass. No installer,
  release, version or tag was produced; installed agents need a later update.
- PR754 merged at **9b7ef88a55b780f153ed4271ba46d3eaa0de1b63**: expanded opponent
  columns, explicit latest replay download, private bounded summaries and saved
  preferences. Final head64e3a771 passed full API/web/responsive/Vercel checks;
  fresh merge tree equaled tested tree917afb5a. Test-only stale consumer mocks
  were corrected (111 unit checks, nine coaching browser cases and two manual
  fixture bundle checks). PR750 is closed as superseded. Vercel production UI
  confirms 9b7ef88 Ready at deployment2GDVmsfS7sYi6dHw7uLnf2hEAn4t.

## Status page: shipped and hostname repaired

The owner confirms no status provider was ever configured. Public
status.sc2tools.com currently returns Vercel DEPLOYMENT_NOT_FOUND. The hostname
resolves to Vercel but is absent from the sc2tools project's Domains list.

- PR **755**, branch codex/fix-public-status-page, worktree
  `C:\SC2TOOLS\.worktrees\wave3-my-reviews`.
- Final head **d7072318602912e138c3919690f5da91659b873c**, final tree
  **98c428fdb7f22527f5c1a7e15bd698c53a1d9867**. Includes actual main9b7ef88;
  ancestry-only reconciliation left the validated tree unchanged.
- `/status` renders outside Clerk/app background providers. Initial Unknown
  results; browser-only website/API public pings, manual Refresh, completion
  timestamps, omitted credentials, four-second whole-request deadline. No new
  service, cron, DB/queue claims, owner data or writes.
- Exact status hostname redirects308 to https://sc2tools.com/status, stripping
  path/query. Preserve private auth guards. Attach alias to the existing Vercel
  project's Production environment **after** primary /status is deployed.
- 233 focused checks, full types, strict lint, Help index, production build and
  unchanged budgets pass. Engine25b300818c31d41b,1.6.12/Python3.14.2 rebuilt and
  smoke-parsed. 172 browser assertions pass at320/390/768/1440, both themes;
  root reviewed four owned screenshots. See public-status-checkpoint.md.
- Full web/responsive/Vercel checks passed after correcting an old Help FAQ
  order expectation (seven focused FAQ checks and lint passed). PR755 squash
  merged as **c7bf67e7e9cbf8ea8eac4706844b96d4a3ba7696**, exactly the tested tree.
  The initial preview hit Vercel's rolling deployment limit; the necessary
  test-fix head later deployed successfully to PreviewHvCHwokvT7JAUjWEysP7d971MAKa.
  Main's automatic deployment was absent, so root created ONE normal Production
  deployment for verified mainc7 through the authenticated Vercel UI. It was
  accepted and Building as sc2tools-5ay50jl2x-jonathan-laymans-projects.vercel.app.
  Once primary/status became200, root attached exactstatus.sc2tools.com to the
  existing project's Production environment. Valid Configuration confirmed;
  aliasroot and syntheticpath/query return308 to cleanhttps://sc2tools.com/status.
  ActualChrome showed both Website/API Reachable and manualRefresh updated
  timestamps19:16:30→19:16:36EDT. Live screenshot inspected. No plan change,
  second provider/account, deployment deletion, DNS/credential change or repeated
  retry occurred. Status repair is COMPLETE.
- Chrome Vercel browser session is authenticated: tab1160793790, session
  Status repair, team jonathan-laymans-projects/project sc2tools. It is currently
  at Domains settings after successful alias attachment. Reacquire only if
  stale, refresh computer-use docs after compaction. No credentials were read.
- Public deliverable Chrome tab1160793908 is at primary/status and marked to
  remain open. PR755/sourcecheckpoint contain live evidence. No paid service.

## Active source work — preserve all files

1. **UI primitives**, new branch codex/wave5-ui-primitives in
   `C:\SC2TOOLS\.worktrees\wave3-game-workspace`, now fast-forwarded to mainc7.
   The previous merged cache branch978a843f and cache are preserved.
   Subagent columns_api owns source; its copy subagent has four frozen files
   and18 passing scoped checks. New Sheet/Popover/IconButton/useConfirm/
   CopyButton/useCopy/SkeletonChart/Kpi plus shared focus/placement helpers and
   tests are ready for a root local commit. All74focused checks, full types,
   strict26-filelint and12native browser cases at360/768/1280 pass, including
   actual fonts/both themes. Root inspected three checked-in captures. Corrected
   real native focus-return/outside-pointer/portal traversal, radio tab stops,
   offscreen bounds and stale confirmation callbacks. Layer context preserves
   root Modal50, nested popup51/child Modal52 and Toast60. No production build
   or bundle/full-suite proof yet. Serialize local heavy work. This is
   only the reusable-contract pack; gallery, UI lint and consumer migrations
   remain, and existing typed UNPAIR/controlled destructive dialogs stay intact.
2. **Nav731** integrated main9b7ef88 as local commit
   e5b5a89575bd609b8914757bddba22461e7a29fd in
   `C:\SC2TOOLS\.worktrees\wave3-build-exports`. Not pushed/tested yet. Union
   detail-sort whitelist, controlled URL state, passive persist:false and754
   explicit preference persistence are preserved. Twenty integration cases and
   synthetic columns-fixture compatibility were added. **Eleven pre-existing
   owner PNG edits remain byte-identical and unstaged**; hash audits are in
   .cache/nav-main9b-owner-png-*.json. Never reset/stash/stage those implicitly.
   Root ran50integration/preference/navigation tests and full types/strict
   eight-filelint, all passed. Integrate755/mainc7, then build/budget and real
   navigation/columns/autoscroll browser matrices before final push/CI.
3. **A11y752**, head99806e8d, worktree wave4-agent-dashboard, is still frozen.
   Preserve caches and two unrelated web .tmp files. The obsolete opponent
   section-order temporary script is wrong and must not run. Main9b/status
   integration and final remote gates remain. Coordinate UI-foundation tokens.
4. **Requested Macro Breakdown build editor** is being implemented on new
   branch codex/macro-build-selector in wave3-coaching-forms, fast-forwarded to
   mainc7. Prior754 branch/cache are preserved. Native screenshot's Planned
   badge was a confirmed manual check-in; owner acknowledged the misclick.
   Existing correction is game page Checked in→Edit→Change→Confirm, or No set
   build. Owner now explicitly requests the same controls in Macro Breakdown.
   Both standalone score modal and inline game macro section have an intent-only
   lazy editor using real BuildCheckInCard, visible through macro loading/error.
   Existing game/header/provider cache is reused. Overlay agent authors shared
   owner/game pending-write gate and JWT/body/deadline/ABA retirement, including
   synchronous callback retirement; replay agent authors UI/tests/manual matrix.
   Source is uncommitted; combined tests/types/lint/build/browser remain to run.
   Do not use the unfinished new UI primitives for this urgent feature.

Latest Randomizer question was answered from source: native page is a silent
shared-pool editor/saved-result display. Animation/sounds/speech live in widget.
Check-in Randomize still requests a server-selected saved pick without OBS;
no duplicate native animation/RNG/audio runs. No removal was requested or made.

Other pending packs remain: auth return736, dossier742/execution748,
landing745/try751, plus later Wave5/6. Do not mark the roadmap complete because
pieces of a pack exist. Reuse existing primitives, bounded analysis-corpus API
and other foundations rather than duplicating them. The final owner setup guide
must reconcile owner-setup.md with implemented environment variables, AtlasM10
backups/restore, Render/Vercel/R2/Clerk, deployment order and optional features.

## Constraints

No AI/model calls; no production migrations/deletions or provider feature
activation/title publication; no signing/releases/version bumps/tags. Keep
infrastructure flat and bundle budgets unchanged. Preserve primary owner work,
every branch, worktree and cache. Use only first-party app check diagnostics for
CI, exact full head SHA and returned IDs. Small local worker counts; serialize
builds, test packs and browser processes after the earlier PC crash.
