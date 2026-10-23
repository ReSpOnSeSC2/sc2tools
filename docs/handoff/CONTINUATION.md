# Upgrade continuation

The owner requested the entire handoff program and no AI features or AI API calls. Preserve the existing infrastructure and ship tested PRs in dependency order.

## Shipped repair

- PR #647 had already merged when this continuation began. Its description is now filled accurately.
- PR #648 repaired all 12 confirmed findings and the bundle failure, and placed opponent replay history immediately above notes. Every GitHub check passed before squash merge at `4533af74034bafdb43a384ea3afde2b1a26ca3bf`.
- Original branch `claude/build-selection-tracking-en3jx0` received a merge of repaired main without rebasing. Its merge tree exactly matches green main.
- The original review and every disposition are in `review-findings-phase2a.md` and `review-resolution-phase2a.md`.
- Full local repair web suite: 5,869 passed, 1 skipped. Local full API coverage exhausted the default 4 GB Node heap; focused regressions and the full GitHub API job passed.

## Phase 2b supplied patches

Integrated in `codex/wave1-phase2b-help`:

- help-content-backfill
- analyzer-home-polish-1
- reviews-coaching-docs-1

Integration preserves lazy help links, accurate filter scope, explicit `?view=today`, review rollout behavior, and heading anchors. The registry has 48 articles. Help search loads the heavy index on demand: `/help` is 150.1 kB against its unchanged 185 kB budget. All route budgets pass. Full web suite before the search split: 5,949 passed, 1 skipped; after the split, 119 affected tests passed. TypeScript and strict changed-file lint pass.

## Remaining phase 2b work

All item specifications remain in `plan/phase2b-items.json`. Area branches are preparation, not claims of completion:

- `codex/wave1-phase2b-analysis`: game-page-polish-1/2, opponents-polish-1/3, builds-polish-1.
- `codex/wave1-phase2b-experience`: settings-onboarding-polish-1, landing-try-polish-1/2/3, chrome-nav-polish-1.
- `codex/wave1-phase2b-operations`: admin-polish-1/2/3.
- `codex/wave1-phase2b-reviews`: reviews-coaching-polish-1.

Still to implement and verify: community-polish-1/2, guides-polish-1/2, profiles-replays-polish-1, streamer-polish-1, agent-gui-polish-1/2. Then continue waves 2–6 in `plan/final-plan.json` and write the complete owner setup guide at `docs/SETUP_GUIDE.md`.

The primary `C:\SC2TOOLS` checkout has unrelated owner edits. Work stays in isolated worktrees under `.worktrees`; never stage dependency junctions or rewritten ladder-map-pool data. Use explicit staging paths.
