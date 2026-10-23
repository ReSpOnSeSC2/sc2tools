# Upgrade continuation

The owner requested the entire handoff program and no AI features or AI API calls. Preserve the existing infrastructure and ship tested PRs in dependency order.

## Shipped repair

- PR #647 had already merged when this continuation began. Its description is now filled accurately.
- PR #648 repaired all 12 confirmed findings and the bundle failure, and placed opponent replay history immediately above notes. Every GitHub check passed before squash merge at `4533af74034bafdb43a384ea3afde2b1a26ca3bf`.
- Original branch `claude/build-selection-tracking-en3jx0` received a merge of repaired main without rebasing. Its merge tree exactly matches green main.
- The original review and every disposition are in `review-findings-phase2a.md` and `review-resolution-phase2a.md`.
- Full local repair web suite: 5,869 passed, 1 skipped. Local full API coverage exhausted the default 4 GB Node heap; focused regressions and the full GitHub API job passed.

## Phase 2b shipped

PR #649 merged all three supplied patches with green CI:

- help-content-backfill
- analyzer-home-polish-1
- reviews-coaching-docs-1

Integration preserves lazy help links, accurate filter scope, explicit `?view=today`, review rollout behavior, and heading anchors. The registry has 48 articles. Help search loads the heavy index on demand: `/help` is 150.1 kB against its unchanged 185 kB budget. All route budgets pass. Full web suite before the search split: 5,949 passed, 1 skipped; after the split, 119 affected tests passed. TypeScript and strict changed-file lint pass.

PR #650 shipped review recovery and per-composer map pins. PR #651 shipped both guide packs. PR #654 shipped all three admin packs. PR #652 shipped settings, public-site, consent and navigation polish. PR #653 shipped game-page, opponents and builds polish at `e83984cb`. Each had green applicable GitHub jobs and Vercel before squash merge. Replay history remains directly above opponent notes.

## Remaining phase 2b work

All item specifications remain in `plan/phase2b-items.json`. Area branches are preparation, not claims of completion:

- PR #657, `codex/wave1-phase2b-community`: community-polish-1/2 and profiles-replays-polish-1. Actual production 404/5xx and responsive behavior verified; an older smoke test now expects the fixture's real network failure instead of accepting a false 200. CI rerunning at `cad55915`.
- PR #658, `codex/wave1-phase2b-agent-polish`: agent-gui-polish-1/2. Real offscreen Qt coverage and full local agent suite passed. CI exposed a Windows slider wheel case and a help-search expectation; fixes are in progress. This branch is not shipped yet.
- PR #656, `codex/wave1-phase2b-streamer`: streamer-polish-1. Shared overlay reconnect/terminal states and six Dock panels' snapshot/save recovery implemented. Local focused suites, production budgets and screenshots pass. CI rerunning at `51daf736` after aligning the old settings skeleton assertion; responsive smoke and Vercel passed.

After those PRs are tested and merged, all 25 phase 2b packs are shipped. Continue waves 2–6 in `plan/final-plan.json` and write the complete owner setup guide at `docs/SETUP_GUIDE.md`. Do not mark a pack done just because it has a branch.

## Wave 2 preparation

- Draft PR #655, `codex/retire-server-ml`: removes unused server model training, keeps one-release authenticated 410 responses, splits server/desktop Python requirements, adds an actual-image dependency guard and spatial smoke, help and a runbook. All GitHub jobs, actual Docker image build, Python/parity and Vercel passed at `e084859a`. Hold its merge until remaining Wave 1 work ships.
- The automatic approval reviewer blocked adding the irreversible `ml_models` / `ml_jobs` cleanup migration. The human explicitly replied **“Approve adding the migration”**. The approved migration is now in #655, tested only against temporary MongoDB. This does **not** authorize executing it against production. No production database was changed. Runbook: `docs/runbooks/retire-server-ml.md`; owner setup notes record the same limit.
- `codex/wave2-pairing-web`: shared normalized code form with explicit PC preview/confirmation, bounded connection polling, device cards/labels/unpair recovery, metadata-aware atomic pairing API and help are implemented. Local validation: 178 web tests in 24 suites and 30 real-Mongo/API tests in two suites, TypeScript and strict changed-file lint pass. Final main integration and production rebuild precede its draft PR. Deploy API before web; the desktop URL/metadata change belongs to the coordinated agent release.
- `codex/wave2-realtime`: user/admin shared connection and batched refresh work is in progress in an independent worktree. Overlay and Dock token sockets remain separate.
- Later guide polish packs 3–5 are in progress independently. Agent pairing recovery and calm sync use a separate branch based on #658. Defer the canonical agent version bump and owner-pushed tag until all coordinated Wave 2 agent changes are integrated and validated.

The primary `C:\SC2TOOLS` checkout has unrelated owner edits. Work stays in isolated worktrees under `.worktrees`; never stage dependency junctions or rewritten ladder-map-pool data. Use explicit staging paths.
