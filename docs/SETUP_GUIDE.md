# SC2 Tools setup and operations

Use this guide to configure the web app, API and Windows agent, verify a
deployment, and find the owner actions still recorded in the roadmap.

## Local development

1. Install the Node and Python versions pinned by the repository and use a
   disposable MongoDB database. Run `npm ci` in `apps/api` and `apps/web`.
2. In `apps/api`, copy `.env.example` to `.env`, set the API variables below,
   and run `npm run dev`. Check `/v1/health` before starting the web app.
3. In `apps/web`, copy `.env.example` to `.env.local`, set the web variables
   below, and run `npm run dev`. Use a development Clerk instance and disposable
   replays for authenticated tests.
4. Follow the desktop runbook for Windows installer verification. Local code
   checks and CI can verify parsing and protocol behavior with fixtures.
   Pairing, upgrades, capture and OBS require an installed-agent acceptance run.

For app-specific commands see the [API README](../apps/api/README.md), the
[web README](../apps/web/README.md), and the
[Windows packaging guide](../apps/agent/packaging/README.md).

## All-in-one OBS layouts

Open [Settings → Overlay → Theme → Layout](https://sc2tools.com/settings?tab=overlay#layout).
Arrange widgets around the marked HUD areas and save the overlay display. The
All-in-one source uses your landscape layout at 1920 × 1080. For a vertical
scene, copy the separate private vertical URL from Layout and set the OBS
Browser Source to 1080 × 1920. Verify both scenes off-air. Use **Reset layout to
default** and save to restore the stock widget positions for that orientation.

## Environment variables

Keep secrets in the relevant platform's environment store or a gitignored local
environment file. Web variables beginning with `NEXT_PUBLIC_` are included in
the browser bundle. Redeploy the web app when they change.

| Where | Variable names |
| --- | --- |
| Render API, required | `MONGODB_URI`, `CLERK_SECRET_KEY`, `SERVER_PEPPER_HEX`, `CORS_ALLOWED_ORIGINS` |
| Vercel web, required | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_API_BASE` |
| API deployment and access | `MONGODB_DB`, `CLERK_JWT_ISSUER`, `CLERK_JWT_AUDIENCE`, `CLERK_WEBHOOK_SECRET`, `SC2TOOLS_ADMIN_EMAILS`, `SC2TOOLS_ADMIN_USER_IDS` |
| Web deployment | `NEXT_PUBLIC_SITE_URL`, `SC2TOOLS_API_BASE`, `NEXT_PUBLIC_BUILD_SHA`, `VERCEL_GIT_COMMIT_SHA` |
| R2 storage | `GAME_DETAILS_STORE`, `REPLAY_FILES_STORE`, `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PREFIX`, `R2_REPLAY_PREFIX`, `R2_BROWSER_CORS_AUTO` |
| Atlas backup status | `ATLAS_SERVICE_ACCOUNT_ID`, `ATLAS_SERVICE_ACCOUNT_SECRET`, `ATLAS_SERVICE_ACCOUNT_SECRET_EXPIRES_AT`, `ATLAS_ORG_ID`, `ATLAS_PROJECT_ID`, `ATLAS_CLUSTER_NAME` |
| Optional recurring support link on Vercel web | `DONATIONS_RECURRING_URL` |
| Web push on API | `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT` |
| Guides and Community revalidation | `GUIDES_REVALIDATE_URL`, `GUIDES_REVALIDATE_SECRET`, `COMMUNITY_REVALIDATE_URL`, `COMMUNITY_REVALIDATE_SECRET` |
| Reviews, guides and browser import rollout | `REVIEWS_ENABLED`, `NEXT_PUBLIC_REVIEWS_ENABLED`, `GUIDES_ENABLED`, `NEXT_PUBLIC_GUIDES_ENABLED`, `NEXT_PUBLIC_INSTANT_IMPORT` |
| Streaming providers on API | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET`, `TWITCH_REDIRECT_URI`, `TWITCH_EVENTSUB_CALLBACK_URL`, `TWITCH_AUTOMATION_ENABLED`, `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `KICK_REDIRECT_URI`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `PLATFORM_TOKEN_ENCRYPTION_KEY`, `PLATFORM_INTEGRATIONS_RETURN_URL` |
| Windows agent | `SC2TOOLS_API_BASE`, `SC2TOOLS_STATE_DIR`, `SC2TOOLS_REPLAY_FOLDER`, `SC2TOOLS_OBS_HOST`, `SC2TOOLS_OBS_PORT`, `SC2TOOLS_OBS_PASSWORD` |
| Agent release workflow | `SIGNPATH_ENABLED`, `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, `SIGNPATH_AGENT_CONFIG`, `SIGNPATH_INSTALLER_CONFIG` |

Use the [cloud setup instructions](cloud/SETUP_CLOUD.md) for connecting the
existing Clerk, Atlas, Render, R2 and Vercel services. See the
[API configuration loader](../apps/api/src/config/loader.js) for optional
integration and worker settings. Keep `USER_CACHE_ENABLED` off under the
[cache activation review](runbooks/chart-cache-activation-review.md).

The donation meter uses manually verified support entries. Set the optional
recurring support URL only after checking that it is the intended HTTPS
destination. Use the admin Supporters page to review entries and confirm the
amount and currency before verification. See the
[deployment guide](DEPLOYMENT_GUIDE.md).

## Shared replay playback storage

New playback uploads use opaque version 2 object paths derived from the
existing `SERVER_PEPPER_HEX`. Keep that value consistent across API instances
and deployments so reads and account deletion can find these objects. Pending
legacy uploads and completed legacy playback keep their original storage
paths. Shared links play those recordings through the API.

For direct browser playback of new recordings, the existing replay bucket can
allow GET from the deployed web origins. The verified API stream also works
with the original CORS rules. Turning a share off blocks new requests. A direct
segment URL already issued may work for the remainder of its 60-second life.

Once version 2 uploads exist, roll back only to an API build that can read and
delete both layouts. Older API builds only know the legacy layout. Restore
the compatible API to recover access to version 2 recordings.

## Rollout and rollback

1. Check the PR's exact head and use a merge commit after the checks pass.
   Record the resulting main SHA. Main workflow runs and the two production
   deployments must correspond to a commit containing the change.
2. Verify the Render API deployment and `/v1/health` before relying on the
   new behavior in Vercel. Check the public web page and the relevant
   authenticated route using a disposable account. Use the deployment and
   workflow links as delivery receipts.
3. Cut an agent tag only after the version in
   `apps/agent/sc2tools_agent/__init__.py` and both changelogs agree.
   The tag must be unused and point at the verified main commit. Regenerate
   Instant Analysis availability and sample payloads through the repository
   generators after version changes.
4. The `agent installer` workflow attaches the installer and checksum to
   a draft GitHub Release. Verify its version, checksum and signing status.
   Publish the draft after review and verify the release feed. Check the
   [latest published agent](https://github.com/ReSpOnSeSC2/sc2tools/releases)
   against the release under test before starting installed acceptance.

Agent 0.25.0 belongs to the growth release. Check the latest published release
and available tag before building a roadmap installer. If 0.25.0 ships before
these native changes reach main, use the next unused agent version after that
release. Installed acceptance and signed delivery are owner steps.

For a source regression, revert the affected change through a checked PR.
Roll the web back before removing an API contract it uses. Follow the
restore runbook for data recovery. Preserve released tags and assets.
Ship an agent correction under a fresh version after verifying the updater
feed and match, capture and OBS guards.

## Backups and restore

- **MongoDB.** Check Atlas Cloud Backup schedule, retention, latest snapshot
  and point-in-time coverage. The Infrastructure card uses a read-only Atlas
  service account. Record a successful restore drill into an isolated
  cluster before claiming restore readiness.
- **One account.** Use Settings → Backups & data → Snapshots. Inspect the
  preview, preserve the recorded revision for the restore, and verify the
  pre-action snapshot. The restore report identifies the replay files kept
  and which games need to sync again.
- **R2.** Atlas snapshots include the metadata for R2 objects. They do not
  include replay originals, R2 replay details or snapshot archives. Keep
  recoverable local originals for re-sync. An unavailable snapshot archive
  requires separate recovery evidence.

See the [database restore runbook](runbooks/restore-database.md),
[user snapshot runbook](runbooks/user-snapshots.md), and
[Atlas backup decision](adr/0073-database-backups-atlas-cloud-backup.md).

## Owner configuration and acceptance

| Roadmap | Owner action |
| --- | --- |
| 12 | Record the Atlas retention policy, snapshot freshness and successful isolated restore drill. |
| 14–18 | Install and upgrade on Windows. Exercise pairing retry and code refresh, unlink/relink, offline recovery, pause/Undo, single-instance and tray behavior, folder discovery, startup migration and uninstall choices. Verify that updates defer during a match, OBS use and capture. Complete the signed installer run when SignPath is configured. |
| 22 | Run the guarded read-only count for legacy embedded snapshot rows. If any remain, review the migration dry run and preserve the resulting receipt. Use a disposable restore for acceptance. |
| 25 | Run the read-only retired-collection audit, then follow the approved production cleanup procedure. See the [server ML retirement runbook](runbooks/retire-server-ml.md). |
| 36, 37 | Compare released scouting facts and linked-account grouping on the private web dossier, live view and desktop card. Verify game matching, private notes and stream visibility controls. |
| 48, 51 | Use an off-air OBS scene to verify source creation, scene changes and source URL repair after token rotation. Preserve unrelated sources and user assets. |
| 54, 56 | Authorize eligible platform connections and incremental scopes in the owning account. Verify live markers, delivery status, throttling and unchanged-title behavior. Automatic ranked Predictions require trusted ranked queue evidence. See the [provider setup notes](handoff/plan/owner-setup.md#twitch-predictions-and-game-markers-wave-4). |
| 62, 76, 77 | Verify installed Recent and skipped-retry history, Health and Sync health actions, System check, redacted support bundle, credential migration and signed delivery. See the [agent acceptance runbook](runbooks/agent-0.24.7-acceptance.md) for the test pattern. Use the version under release. |
| 64 | Verify the configured Guides and Community purge receivers and actual edge behavior. Keep private data on its documented no-store paths. |
| 74 | Keep the cache gate off and verify the deployment and revocation contract before any activation review. |
| 78, 84 | If enabling direct browser reads, add a GET rule to the existing replay bucket for the deployed web origins. Preserve the upload rules. Test an owned original download and replay-pack ZIP in a real browser. Then verify a revocable share's playback segments signed out through the API. Direct storage reads for shared playback require opaque object keys. |
| 79 | After the native release, pair the updated desktop agent and try a small re-analysis cohort. Check a replay on disk and one fetched from the archive, pause/resume, and verify the new engine stamp. |
| 85 | Record, cancel and download a short clip in a supported desktop browser. Check the final file duration, replay frames, scoreboard and watermark. Repeat across a recorded replay section boundary and with GIF where available. |
| 93–95 | Supply the matching VAPID key pair and subject on Render to enable push. Subscribe on a test device and verify opt-in categories, notification delivery and unsubscribe. Use a disposable Discord channel to verify opt-in delivery and revocation. Test promotion posts with two observed league values for the same ranked account and race on the updated agent. Keep private calendar links and account exports out of logs and shared screenshots. Verify an export after direct sign-in contains the active secret for a link created with `PLATFORM_TOKEN_ENCRYPTION_KEY` configured. Older links keep working until rotated or revoked. |
| 90, 96, 184–187 | On the released agent, try a fresh link and an existing link, replay folder and history choices, Save and Revert, shortcuts, restart-required changes, tray status and Practice HUD placement. Check voice, countdown and capture exclusion off-air. |
| 157–159 | On an off-air OBS scene, verify the timed poll, clip log, Large overlay scale and starter widget connections. Source presence is checked by connection; confirm visibility and audio directly in OBS. |
| 87, 193, 194 | After updating and re-analyzing a replay, follow both cameras, check the attention heatmap, compare recorded control-group and camera phases, and verify unit trades, lifespans and build-supply labels. |
| 189 | In Chat & alerts, open Twitch automation and connect Channel Points reward actions separately. Grant the incremental reward scope in the broadcaster’s account, choose the OBS source and save an enabled mapping. Verify one controlled redemption for each action you use, plus cooldown, unavailable-action handling and manual or automatic settlement. Automatic settlement requires an app-managed Twitch reward. Disable the mappings or disconnect reward permission to stop actions. |
| 191 | Pair a released Windows agent, enable the desktop roll in Settings → Randomizer and load an eligible human 1v1. Verify Play it, one Reroll, Not now and the private Challenge totals. Repeat with an active Randomizer source to confirm the browser handles the roll. Check that resetting the Challenge keeps the replay and build library. |
| 195 | Test the React Locker roster with a disposable linked account, including local backup and revision-checked restore. Keep Classic available and record one week of use before retiring the roster’s HTML view. |

Use the [roadmap ledger](handoff/roadmap-progress-2026-10-28.json) for
requirement-level status and the [Windows release runbook](runbooks/agent-wave2-release.md)
for native release and rollout checks.
