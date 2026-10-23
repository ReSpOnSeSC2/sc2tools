# Upgrade continuation

The owner requested the entire handoff program, including waves 2–6, and no AI features or AI API calls. Preserve the existing infrastructure and ship tested PRs in dependency order.

## Repair and Wave 1 complete

- PR #647 had already merged at the start. Its description is filled accurately.
- PR #648 repaired all 12 confirmed findings and the bundle failure, and put opponent replay history immediately above notes. Every applicable GitHub check passed before merge. The original branch received repaired main without rebasing.
- Review evidence: review-findings-phase2a.md and review-resolution-phase2a.md (all 44 dispositions).
- All 25 Wave 1 phase 2b packs are merged with green applicable CI and Vercel: #649 (three supplied patches), #650 (reviews), #651 (guides 1/2), #652 (settings, landing, consent, navigation), #653 (game/opponents/builds), #654 (admin), #656 (streamer), #658 (desktop GUI 1/2), #657 (community/public sharing).
- Completed Wave 1 main: 3368867dffc7837734cdb202f0204159b2460992. Replay history remains directly above opponent notes.

## Wave 2 shipped

- #655 retired unused server model training. Squash d51e07b0. All applicable CI, the Docker dependency/spatial smoke and Vercel passed. The approved collection migration remains manual and has not run in production.
- #659 completed web pairing and device management. Squash e36cd9cb. All applicable CI and Vercel passed. Deploy its API before the web; existing agent token polling stays compatible.
- #663 shipped resumable five-step setup and atomic onboarding field patches. Squash 041eaba9. All API/web/smoke/Vercel gates passed at ea539b80; post-integration 112 web tests and ten actual HTTP/Mongo tests passed.
- #664 shipped build editor draft protection, private notes and definition details. Squash 076a61f6. All applicable GitHub checks and Vercel passed at 0ddb659c.
- #660 shipped one authenticated user/admin connection, accurate inserted counts and coalesced expensive refreshes. Squash 8d44f069. All applicable API/web/smoke/Vercel gates passed at fef7fe51. Eight user and three admin consumers were tested together.
- #666 shipped setup health, diagnostic copy, desktop import/history for all signed-in accounts and checklist pairing/Undo/restore. Squash 984eb435. All GitHub web/smoke/Vercel gates passed at b189f9ad. No production import or account change was executed during implementation.

## Wave 2 prepared

Each remains a draft until final integration and CI are green; a branch is not completion.

- #661, codex/wave2-agent-recovery, 4ce7befa: non-quitting pairing recovery, credential refresh/upload hold and calm queue retries. Main through #660 integrated. The Windows priority regression now holds a real live request while asserting history stays deferred, avoiding a one-second CI deadline and a post-success race. Nineteen calm-sync tests pass; final remote rerun pending (previous full exact-head local suite: 2,006 passed, one skipped, 78 subtests).
- #662, codex/wave2-guides-polish, 4d837114: guide packs 3/4/5; 448 tests, types/lint, unchanged budgets, 21 production browser checks and four inspected screenshots. Main through #660 integrated; final remote rerun pending.
- #665, codex/wave2-notification-center, 4bd0a671: complete notifications, support replies, muting, inbox and My reports. Main through #660 integrated; 197 post-integration web tests/typecheck pass. The inbox stays independently authenticated when Reviews is disabled; 84 actual rollout route probes verify all 28 Reviews routes remain hidden. Final remote rerun pending.
- #667, codex/wave2-builds-library: build packs 3/4/5; 389 web tests, 26 actual API tests, both typechecks, strict lint, production budgets and four browser flows passed before draft. Main through #664 integrated; needs latest realtime integration before shipping.
- #668, codex/wave2-agent-runtime: desktop window/tray/folder, match-aware scheduling and GUI pack 3; main through #664 plus #661 integrated. Latest full local suite: 2,075 passed, one skipped, 78 subtests. Optional service notice contract is shared with the What's New follow-on. Installer work is separate; no release tag was pushed.

## Approval scope

Automatic review initially rejected the irreversible ml_models/ml_jobs cleanup migration. The human explicitly replied “Approve adding the migration.” The approved migration is included in #655 and tested only against temporary MongoDB. This does not authorize running it against production. No production database was changed. Read docs/runbooks/retire-server-ml.md before any separately authorized execution.

## Active follow-on work

- API agent: What's New/status, then snapshot/account data safety and ops/admin follow-ons. Preserve the atomic onboarding merge; new seen-time writes submit only their field.
- Chrome agent: coaching/reviews follow-ons, then community/public sharing. Small optional Tabs.Content and SaveBar props must preserve existing behavior. It avoids the shared focus/filter sources.
- Desktop agent: installer/autostart and unsigned local packaging validation. Signing is conditional on real owner-provided credentials and certificate approval; never claim a signed build without them.
- Defer canonical agent version bump and owner-pushed release tag until all coordinated Wave 2 agent changes are integrated and validated. Do not claim a signed installer without actual signing credentials.
- Root: analyzer-home-polish-2/3 prepared on codex/wave2-analyzer-polish, then opponents packs 2/4 and game header pack 3. Continue every remaining item in plan/final-plan.json through waves 2–6 and write the complete owner setup guide at docs/SETUP_GUIDE.md. These later waves are not complete.

The primary C:\\SC2TOOLS checkout has unrelated owner edits. Work stays in isolated worktrees under .worktrees. Stage explicit paths; never stage node_modules junctions or test-rewritten ladder-map-pool data.

## Setup health follow-on prepared

codex/wave2-setup-health completes settings-onboarding-polish-2: independent health rows/retry, safe diagnostic copy, desktop imports for every account, ten-job history, compact inline pairing, setup progress and deferred five-second dismissal Undo/restore. Local affected run: 272 tests; full application web run: 6,191 passed and one intentionally skipped, plus the display-only render harness. Web types/strict changed-file lint and all unchanged production budgets pass (/app 238.3/240). Real component fixture screenshots at 390/1440px were inspected with no overflow or browser errors. Games.latest is the played-game date, so its label truthfully says latest game rather than last sync. Depends on the atomic onboarding merge in #663. No live account or production import was changed.

## Analyzer follow-on prepared

codex/wave2-analyzer-polish includes #666 to check the combined dashboard: 1,732 tests in 200 affected suites pass, full web types/strict changed-file lint pass, and every production budget is unchanged (/app 234.4/240). The filter editor loads when needed, preserving dashboard headroom. Four 390/1440px screenshots use actual interactive filter/Trends controls, sample API data and labelled chart placeholders with production CSS/fonts. Chromium verifies editor bounds, nested Escape/focus and jump headings clear the measured sticky navigation. These are fixture renders, not live authenticated production sessions. No production account data was changed.
