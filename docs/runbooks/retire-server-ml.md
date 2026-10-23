# Retire unused server ML

The API no longer trains models or runs predictions. For one release, authenticated `/v1/ml` requests return HTTP 410. Replay parsing and spatial KDE keep their existing rules and statistics.

The owner approved adding the forward-only collection cleanup on 2026-10-23. That approval did **not** authorize running it against production. No production database was changed during implementation.

## Deployment

1. Build the API image from the repository root using `apps/api/Dockerfile`. Its server-only Python environment contains sc2reader, numpy, and scipy. The build checks installed dependencies and executes `spatial_cli maps`; it fails if sklearn/scikit-learn, torch, or transformers are installed.
2. Confirm the existing database backup status and record the intended database name. Pause the old API instance before cleanup so an old process cannot recreate model collections.
3. In `apps/api`, set the existing `MONGODB_URI` and `MONGODB_DB` securely. Run the read-only inventory: `node scripts/audit-retired-ml.js`.
4. Preview the exact collections and counts: `node src/db/migrations/2026-10-23-retire-ml.js --dry-run`.
5. Obtain approval to run the production cleanup. Then run the same migration without `--dry-run`. It drops only `ml_models` and `ml_jobs`, permanently removing trained models and training-job history. It never modifies games, replays, users, or build rules. A repeated run does nothing.
6. Deploy the new API and verify replay preview, Map Intel, and the 410 compatibility response.

## Rollback

The application change can be reverted. The forward-only cleanup has no automatic rollback; restoring retired model records would require the recorded backup. Reverting to an old API can recreate its empty model collections. Do not restore model tooling merely to recover normal replay analysis.
