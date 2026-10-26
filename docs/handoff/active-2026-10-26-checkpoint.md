# Active upgrade checkpoint — 2026-10-26

This checkpoint supersedes the active-work and deployment claims in the older
October 25 checkpoint. The owner again asked to continue the authorized program
after the latest corrections. The whole roadmap remains open; consult
`plan/final-plan.json`, each feature checkpoint and the source before deciding
whether a particular item is complete. The final `docs/SETUP_GUIDE.md` remains
required at the end.

## Owner corrections already delivered

- Preserve the live opponent order: Brief, Tendencies, Timings, History,
  Ladder, Identity. History remains above Notes. Do not revive withdrawn PR739
  or execute the obsolete opponent-order temporary script.
- Seven-minute Void Ray/Phoenix opening criteria, passive composition loading,
  expanded opponent columns, saved column choices and explicit latest-replay
  downloads are merged. No production replay recomputation was performed.
- Planned-build corrections are available through the real build editor. The
  PvT early Dark Shrine/actual DT evidence takes precedence over Charge-first;
  proven Robo/Prism evidence keeps DT Drop more specific.
- PR761 is merged as `1c3d987781d91e1338eb7d967da031faa093cd12` and live.
  Macro Breakdown's Change build section is below What you did well. Inspect
  window now marks the selected chart point and explains its ending ten-game
  window, date and coverage; the headline fifty-game estimate stays unchanged.
- The public status hostname redirects to `https://sc2tools.com/status`.
  Refresh on October 26 at 07:20 UTC confirmed Website and API Reachable.
  These public pings establish reachability, not feature health or API version.
- The native Randomizer page remains shared-pool settings and selection;
  animation, sounds and speech belong to the widget. No removal was requested.

## Merged program packs and production evidence

- More Sheet PR762: `378a957d8d38053f5045920de40caf816356da13`.
  Exact-head CI passed 8,735 web tests and 371 browser checks. The responsive
  seam, nested Appearance focus and synthetic full AA checks are recorded in
  `more-sheet-checkpoint.md`.
- Browser demo and Try PR751: `90c444d89ef2d5da039f253c64e7cde1221a6c9e`.
  Superseded Landing PR745 is closed. Exact-head CI passed 8,788 web tests,
  373 browser checks, engine/parity checks and 805 Windows UI tests. Existing
  rollout flags were retained; do not claim a disabled public mode was enabled.
- Dossier and private execution PR748:
  `8daff14574973936a54329183e5f2f136e8ab8b5`. Superseded PR742 is closed.
  Exact-head CI passed 6,261 API tests, 8,827 web tests and 373 browser checks.
  Private grades retain their own sample floors and bounded caches; no raw
  timing logs or sampled game IDs are retained in the baseline cache.
- Vercel deployment `3DaS497bY5H2LQtGG4C6YrufT9Bm` was visibly Ready,
  Production and Current for `sc2tools.com`, with exact source `8daff145`.
  It contains all three packs above and the latest owner corrections.
  Earlier individual deployments hit the daily quota; the later automatic
  deployment succeeded without an upgrade or manual retry. Exact API deployed
  source was not independently established; public API liveness passed.
- Copy-link recovery PR763: merged as
  `1ad5dafa0c8634643a55491cb4ee311fd84c4c41`. Current-head CI passed 8,839 web
  tests across 943 suites and 379 browser checks, with one expected skipped
  web test/suite and 68 intentional browser skips. Fresh-main merge tree
  `df2d90bab365d91d964b43d7910bcd2c15547362` equalled the tested head.
  Automatic Vercel deployment `3gRD1hGQbD3hETuRfWJJqVLTLPYe` is visibly Ready
  and Production, assigns `sc2tools.com` and identifies exact source `1ad5dafa`.
  No manual retry or hosting upgrade was used.

Local production/browser evidence and later ancestry-only integrations are
distinguished in the individual checkpoints. Never claim a whole matrix was
rerun on a later commit unless it was. Keep unchanged route budgets and all
original evidence.

## Active source packs and ownership

1. Build dialogs: `wave3-guides-expansion`, branch
   `codex/wave5-build-dialogs`, agent `public_player`. Actual Dossier, rich
   editor, Practice and menu consumer checks found real focus/empty-state
   issues. Final local proof passes 204 checks/20 suites, types, all 81 route
   budgets and 329 browser checks/48 full AA scans. All 48 Close controls are
   at least 44 by 44 pixels and inside the viewport and dialog. A one-line
   shared Modal header sizing fix removes measured phone clipping; no API
   changes. Root reviewed/copied three final captures. Remote CI, merge and
   deployment are pending; local runtime is closed and its slot is released.
   Root owns Git and this program checkpoint. Preserve every RED receipt.
2. Replay-sharing copy: `wave4-agent-dashboard`, branch
   `codex/wave5-replay-sharing-copy`, agent `columns_api`. Source-only work
   depends on PR763. Shared manual-copy presentation, explicit private consent
   lifetime and native-share attempt lifetime are being repaired. No runtime
   grant yet. Unknown consent acknowledgements require a fresh existing GET
   on the next explicit open; never automatically undo an authorized write,
   copy a stale handle or claim sharing is off after an uncertain outcome.
3. Notification Popover: `wave3-game-workspace`, branch
   `codex/wave5-notification-popover`, agent `next_ui_audit`. The ten-path source
   pack is frozen from `1ad5dafa`. Root's initial focused pass is 36 checks/four
   suites, after replacing a stale test helper's dialog-only wait with actual
   lazy-panel readiness. Later static/build/browser/remote gates are unrun.
   Preserve lazy data loading, ready-and-merged initial
   focus, read acknowledgements and nonmodal Tab behavior. Existing Popover
   handles outside pointer focus and top-layer Escape. Runtime follows the
   earlier packs; root owns Git.
4. Mobile navigation: `wave3-owner-neighbors`, branch
   `codex/wave5-mobile-nav-sheet`. Eight source paths are authored and frozen,
   with all gates unrun. Reuse standard right Sheet sizing and shared Close,
   preserve home/auth/route/theme controls and the controlled-content ID, and
   close at the desktop breakpoint to release the old hidden drawer's lock.
5. Glossary foundation: `wave3-my-reviews`, branch
   `codex/wave5-glossary-infotip`. A 19-path source-only foundation is approved:
   the seven existing definitions, explicit lazy InfoTip/Term, searchable
   normal Help widget/article and one grouping-control consumer. No runtime
   grant. About forty terms, remaining consumers and Reading your stats still
   need later source-verified expansion; do not claim the whole item complete.

Do not switch these active branches, reset their worktrees or stage their
untracked caches. Source-only agents must not start competing runtime work.

## Remaining program scope

The UI foundation and gallery are delivered; consumer migration is incomplete.
After the active packs, review MobileNav's ID/drawer layout requirements,
remaining confirmations and branded CTA consumers. Glossary/InfoTip,
find-anything/settings search, dashboard/cache and local-corpus completion,
agent/sync health, export/reanalysis, tours and later Wave 5/6 work still need
source/spec reconciliation and implementation. Do not mark a feature done
because a partial foundation exists. Keep the final owner setup guide aligned
with implemented environment variables, Atlas M10 backups/restore,
Render/Vercel/R2/Clerk, deployment order and optional features.

## Release and operational constraints

Agent 0.24.7's version, changelog and annotated `agent-v0.24.7` tag are complete
and pushed to merged commit `ae21f7a284176112021cdcb80781ca7613fc5032`.
The installer workflow stopped at its existing missing SignPath configuration
gate. No installer or draft release exists; no signing setup, installation or
restart is authorized by that version/tag request. See its release checkpoint.

No AI/model calls, new infrastructure, increased bundle budgets, production
migrations/deletions/recomputation or integration/stream activation. Preserve
all owner edits, worktrees, branches, images and caches. Never stage the test-
mutated ladder map pool. Keep local workers small (unit maximum two, browser
one) and serialize heavy runtime work after the PC crash. Do not launch real
StarCraft or the native agent for browser validation. Use exact-head first-party
CI diagnostics, fresh-main tree verification and squash merges after green
gates. Private Admin game observations must never enter public source/evidence.
