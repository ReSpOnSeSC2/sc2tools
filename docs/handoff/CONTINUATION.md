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

## Wave 2 prepared

Each remains a draft until final integration and CI are green; a branch is not completion.

- #660, codex/wave2-realtime, 54644dc3: one authenticated user/admin connection, accurate inserted counts, immediate status counters and batched expensive refreshes. All eight user consumers and three admin consumers tested together. 331 web tests, 71 API tests, types/lint/build/budgets and screenshots passed before final Wave 1 integration; remote rerun pending.
- #661, codex/wave2-agent-recovery, 6cd944c0: non-quitting pairing recovery, credential refresh/upload hold and calm queue retries. Full exact-head local suite: 2,006 passed, one skipped, 78 subtests. All remote gates passed at that head. Still needs #659 and current main integrated before rollout.
- #662, codex/wave2-guides-polish, ce4efa57: guide packs 3/4/5; 448 tests, types/lint, all budgets, 21 production browser checks and four inspected screenshots. Completed Wave 1 integrated; latest remote rerun pending.
- #663, codex/wave2-welcome: resumable five-step setup, atomic goal patches, honest completed chips, browser Back path, live Done step and goal-specific actions. 122 affected web tests, ten real-Mongo/HTTP API tests, types/strict web lint and phone/desktop fixture renders passed. Production /welcome 167.4/245 kB, all budgets unchanged. All remote checks passed at a024c7fa; current main integration is being verified.

## Approval scope

Automatic review initially rejected the irreversible ml_models/ml_jobs cleanup migration. The human explicitly replied “Approve adding the migration.” The approved migration is included in #655 and tested only against temporary MongoDB. This does not authorize running it against production. No production database was changed. Read docs/runbooks/retire-server-ml.md before any separately authorized execution.

## Active follow-on work

- API agent: notification-center full spec/augments, including support/coaching producers, muting and inbox UI. It owns notifications preference routing; preserve the welcome branch's separate atomic onboarding merge in users.updatePreferences.
- Chrome agent: builds-polish-2 first, then 3/4/5 in a separate draft. It owns build editor/library code and optional focusCancel/initialFocusRef primitives.
- Desktop agent: agent-window-tray-folders, agent-match-aware and agent-gui-polish-3 in a new branch based on #661. It owns runner/GUI/queue. Installer/autostart follows separately.
- Defer canonical agent version bump and owner-pushed release tag until all coordinated Wave 2 agent changes are integrated and validated. Do not claim a signed installer without actual signing credentials.
- Root continues welcome and settings-onboarding-polish-2. Then proceed through every remaining item in plan/final-plan.json and write the complete owner setup guide at docs/SETUP_GUIDE.md.

The primary C:\\SC2TOOLS checkout has unrelated owner edits. Work stays in isolated worktrees under .worktrees. Stage explicit paths; never stage node_modules junctions or test-rewritten ladder-map-pool data.

## Setup health follow-on prepared

codex/wave2-setup-health completes settings-onboarding-polish-2: independent health rows/retry, safe diagnostic copy, desktop imports for every account, ten-job history, compact inline pairing, setup progress and deferred five-second dismissal Undo/restore. Local affected run: 272 tests; full application web run: 6,191 passed and one intentionally skipped, plus the display-only render harness. Web types/strict changed-file lint and all unchanged production budgets pass (/app 238.3/240). Real component fixture screenshots at 390/1440px were inspected with no overflow or browser errors. Games.latest is the played-game date, so its label truthfully says latest game rather than last sync. Depends on the atomic onboarding merge in #663. No live account or production import was changed.
