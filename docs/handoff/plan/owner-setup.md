# Owner setup notes (accumulated)

## Wave 2: settings-onboarding-polish-2

No new environment variables or infrastructure. Deploy after the pairing API and atomic onboarding preference merge in #659/#663. Desktop import is available for every signed-in account; browser import still follows its existing flag. Setup health reuses the existing doctor, account, overlay-token and release endpoints. Copy diagnostics excludes emails, credentials and token-bearing URLs. Verify a recent PC connection, a history import and checklist dismissal/Undo; no production import or account modification was performed during implementation.

## Wave 2: pairing-web-and-devices

Deploy the Render API before the web changes: the shared form uses the new authenticated device-preview endpoint and the claim endpoint's 200 JSON response. Existing desktop apps keep working with the token-poll protocol; older apps can still enter codes manually. Newer agent-pairing-recovery releases open `/devices?code=XXXXXX&src=agent` and include bounded PC metadata at start. No new environment variables or infrastructure are required. Network comparison is a salted hint, never an authorization check; raw IP addresses are not stored, and an API restart safely turns an existing code's hint into a mismatch warning. Verify one PC link, its heartbeat, its label and a confirmed Unpair after deployment.

## Wave 2: retire-server-ml

No new secrets or infrastructure. The API Dockerfile installs `apps/replay-engine/requirements-server.txt`, and image CI guards the actual installed dependencies and spatial CLI. Follow `docs/runbooks/retire-server-ml.md` for the read-only audit, dry run, and forward-only cleanup of `ml_models` and `ml_jobs`. The owner approved adding the migration, but production execution needs separate approval and was not performed during implementation. Do not restore the removed model tooling to run ordinary replay analysis.

## Wave 1 phase 2a

### data-states-recovery
none. The Sentry event id under Details only appears when NEXT_PUBLIC_SENTRY_DSN is already set; without it the panel says "Not recorded". The banner's health check uses the existing /v1/ping endpoint, which does not touch the database.

### app-shell-quick-fixes
none. The bundle budget runs in the existing web-ci build job with no new secrets or environment variables. People who installed the app before this release keep their old install (it opens the home page and has no shortcuts) until they remove it and install it again; the install-app help article tells them how.

### help-and-feedback-menu
Nothing is required. The 'Site version' line in reports reads NEXT_PUBLIC_BUILD_SHA, which next.config.mjs fills from Vercel's VERCEL_GIT_COMMIT_SHA at build time. If that variable isn't available to the build (for example, Vercel's 'Automatically expose System Environment Variables' is switched off), either set NEXT_PUBLIC_BUILD_SHA yourself in Vercel > Project > Settings > Environment Variables and redeploy, or leave it unset: reports then simply have no Site version line.

### settings-quickwins
Optional, one step. On the Render API service, look at the `PLATFORM_INTEGRATIONS_RETURN_URL` environment variable (it is `sync: false`, so it's managed in the dashboard).
1. If it is unset, do nothing: the new default is `https://sc2tools.com/settings?tab=overlay#platform-connections`.
2. If it is set to the old `https://sc2tools.com/settings#overlay`, either change it to `https://sc2tools.com/settings?tab=overlay#platform-connections` or delete it so the default applies.
3. Redeploy the API.

The old value still opens the Overlay tab through the fallback for old links, but it won't scroll to Connected accounts.

### backup-status-honest-copy
None required. The new card and alert reuse the existing ATLAS_* service-account settings, and that account already has Project Read Only, which is enough to read backup snapshots and the schedule. No new secrets.
Optional:
1. After deploy, open Admin > Infrastructure and check the "Database backups" card. If it says "Atlas refused the backup check", give the service account Project Read Only on the project in Atlas (Access Manager). If it says "Not connected", the ATLAS_* variables aren't set in Render.
2. To turn off the hourly stale-backup check, set SC2TOOLS_BACKUP_ALERT_DISABLED=1 on the Render API service.
3. Read docs/runbooks/restore-database.md once. Atlas restores have to be done by a person with the Project Owner role, because the app's account is read-only.

### welcome-wizard-resumable

Deploy the API update before the web. Onboarding preference PUTs now merge fields atomically; other preference types retain their existing replacement behavior. No migration, environment setting or release tag is required. The welcome flow depends on the pairing/device API and shared form from `pairing-web-and-devices`.
