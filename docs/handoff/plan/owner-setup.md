# Owner setup notes (accumulated)

## Analyzer section links

The section-navigation pack is web-only and needs no environment variable,
secret, endpoint, migration, scheduler or infrastructure change. Existing
authenticated replay and analyzer endpoints are reused. Copied links contain
validated global filters plus known section controls; they open the recipient's
own data and never enable public replay sharing. Replay cursor/row restoration
uses bounded owner-scoped session storage; clearing it leaves Back to newest.
Search writes use a short debounce and Strategy sheets own one browser history
entry. Help covers the behavior under Filters, Replays and Today.

## Linked scouting and deterministic opening forecasts

Deploy the API before the web so the private `opponentScouting` preference is available. No new environment variable, secret, collection, index, migration, job or infrastructure is needed. The existing identity/account caches and k-floor Ladder Meta documents are read with fixed bounds; scouting does not warm upstream identity links or recompute the corpus. Grouping defaults on and saves per signed-in account; the former unscoped browser value is not silently written into another account. Verify the grouping control and `/help/opponent-scouting#how-the-forecast-works` using disposable fixtures. Existing desktop apps keep their compatible brief until a future ordinary update includes the new confidence copy; no version, installer, tag or release was produced. Revert the web before API on rollback; the saved preference can remain unused.

## Twitch Predictions and game markers (Wave 4)

Deploy API before web. The new `TWITCH_AUTOMATION_ENABLED` server gate defaults off and accepts only the exact value `true`; this work has not set it or activated any integration. Keeping the gate off makes lifecycle hooks, recovery and Dock provider controls inert even if a saved user opt-in is true. Owner enablement is a separate operational decision. No new service, paid plan or production data migration was executed. The bounded `twitch_automation_receipts` metadata collection uses normal startup index definitions (owner/game unique, TTL and bounded recovery/owner lookups), and account erasure removes its owner rows. It is excluded from snapshot restore.

Current desktop telemetry does not prove live ranked queue status. Automatic Predictions therefore remain unavailable even after owner enablement and user consent; do not infer ranked status from Pulse/MMR or advertise that the current desktop can open them. A future supported queue adapter needs explicit end-to-end verification before changing that capability. Fresh known live two-human 1v1 starts can create saved, consented stream markers; Twitch requires a live channel with VODs enabled.

Each eligible affiliate/partner streamer must approve the incremental Predictions permission (`channel:manage:predictions`) or marker permission (`channel:manage:broadcast`), then explicitly Save Twitch automation. Connecting alone enables neither switch. Same-broadcaster reconnects preserve separately consented scopes. In Dock → Game, inspect the confirmed prediction state before using Resolve or Cancel/refund; missing provider IDs require a manual Twitch dashboard check. No real account, provider prediction, stream marker, OBS session or installer was used in validation.

For rollback, turn both user switches off and Save. Before disabling the server gate or disconnecting Twitch, inspect any open native prediction and settle or cancel it in Twitch; the disabled gate also pauses automatic timeout recovery. Retain receipts rather than deleting them to replay old games.

## Synced Ghost practice

Deploy the API before the web so `/v1/me/preferences/ghost` GET/PUT/PATCH and
socket snapshots are available. No environment variable, secret, collection,
index, migration or background job is needed. Existing active overlay tokens
receive the owner's assignments; no integration is enabled. In Settings →
Overlay → Look, explicitly move old browser assignments once if wanted. New
dedicated Ghost URLs remain permanent across assignment changes and clear
actions. Legacy fragments keep working until account configuration is present;
an explicit empty account config disarms them. The URL-specific Voice coach
switch still needs a new copy if changed. Native Companion has separate local
target/assistance controls. No version bump, installer or release was performed.
See `/help/practice-ghost-build`.

## Widget manager

Deploy the API before the web so the authenticated bulk widget-selection PUT is available. No new environment variable, secret, collection, migration or infrastructure is required. Existing tokens and enable/config events are reused. Starter packs require the user's review and confirmation and preserve other enabled widgets. The shared recommended-size JSON is included by the existing desktop packaging specification; no installer, version bump, tag or release was performed. Existing OBS scene dimensions remain unchanged. Verify a local or off-air Browser Source by copying/dragging it, checking its recommended size and using Preview before sending any live sample. The steps are in `/help/obs-overlay-setup`.

## Dossier timings and phases

Deploy the API before the web update. No new environment variable, secret, collection, migration or scheduled task is required. The ordinary web profile is metadata-only and the detailed section uses the private lazy analysis route. Already installed desktop Companions retain the rich old-route response through trusted device authentication; future desktop source uses the explicit analysis route. No desktop version bump or release is required for compatibility. Check `/help/opponent-dossier#reading-key-timings` after deployment.

## Recorded playback guidance and segment streaming

No new infrastructure, secret, environment variable or manual migration is required. Deploy the API and web normally. Authenticated content-addressed segment responses use private immutable browser caching for seven days; manifests remain no-store and every server read still checks ownership. A website-requested artifact upload sends one private `playback_ready` bell notification after verified completion, using the existing notification service and delivery identity. Automatic uploads and viewer polling do not send it. Browser decoded segments have a 24 MB LRU budget; a miss retains the last frame, and Retry remains available. Recording itself stays explicitly requested or controlled by the desktop app's existing default-off automatic-capture setting. No production recording or account operation was performed during implementation.

## Wave 4: desktop stream titles

Deploy the API with the private `GET /v1/agent/streaming/session` route before distributing the desktop code. No new variable, secret, collection, migration, service or release tag is required. Existing SC2 Tools pairing and streaming-account grants are reused. Automatic titles start off and advanced local connections cannot enable them. An individual user chooses platforms and saves the explicit opt-in in Streams; YouTube is unselected initially because title updates consume its quota. No production integration was enabled and no account title was published during development. Stored title consent is bound to the paired API/token fingerprint, so changing accounts requires a new opt-in. Reverting the app/API code stops future automation; private local settings can remain. See `/help/desktop-stream-titles` for the template tokens, 70-character rendered limit, ten-minute throttle, bounded history scope and ambiguous receipts.

## Wave 2: opponents-polish-2 / opponents-polish-4

No new secrets, infrastructure or migration. Deploy the API before the web for batched private `notesMeta.preview` reads. Existing full-note list responses stay compatible. List URLs use `q`, `sort`, `dir`, `impact` and `notes`; future global URL writers must preserve these and unknown parameters. Sort preferences are local, and list return state plus unsaved note drafts stay in the current browser tab. Draft restoration checks the signed-in owner. No production notes or account data were modified during validation.

## Wave 2: analyzer-home-polish-2 / analyzer-home-polish-3

No new secrets, environment variables or infrastructure. Filter wire values and request scopes stay compatible. Today stores its editor visibility at `analyzer.today.showFilters`; Trends keeps `analyzer.trends.bucket` and adds `analyzer.trends.collapsed`. These preferences stay on the current browser. Invalid stored values fall back safely. Help describes the summary, the phone editor and the scope of Today/Arcade. No account data migration or production data modification is needed.

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

### game-page-polish-3

No new environment variable, secret, migration or release is required. Deploy the web normally. Existing replay storage and review rollout settings retain their behavior; completed check-ins open through Edit and close with Done after notes are saved/discarded.

### game-page-macro-workspace / one-game-clock

No new environment variable, secret, database migration or desktop release is required. Deploy the web normally. Recompute reuses the existing authenticated macro request and the paired desktop app; keep that app open with access to the original replay. It reparses the replay and does not record StarCraft II. Timestamp links and metric preferences are browser features. Missing measured banked resources stay hidden.


### Build supply and exports

No environment variable, collection, migration or paid service is required. The API enriches display build events from already-stored player stats; it does not change raw classifier timestamps. After deployment, open an owned game, choose Builds, verify prior-sample supply and use either column’s menu. Header CSV/JSON exports run locally. Custom/Community rule-only definitions copy their matching conditions, and signature deadlines remain identified. Help: `/help/build-orders-export`. No production reanalysis is performed by this change.
# Saved analyzer views

`shareable-views` needs no new environment variables, services, indexes, jobs or migration. The existing private preferences API stores up to twelve named filter/section views. A single indexed user read supplies first-visit saved-view/default-tab behavior. Deploy the API and web changes normally; no production account settings were changed during validation.

# Overlay health

No new environment variable, secret, collection, index, job or infrastructure is required. The API image copies the shared surface/scene allowlist. Deploy API before web, then refresh old OBS Browser Sources once to identify them in Ready to go live? Counts include source pages opened in normal browsers; verify actual scene visibility and audio in OBS. A missing recent game-update timestamp after restart is expected until a replay arrives. No integration or account was enabled during verification.



### Live overlay profiles

Deploy the API and web together for `overlay-profile-sync`. The API Dockerfile includes the authored `overlayProfileRules.json` at its flattened runtime path; no environment variable, collection, index, migration or paid service is added. Existing tokens default safely until their owner explicitly saves a profile. In Settings → Overlay, choose a theme in Look or a timed widget's Display time, then Save overlay display. Confirm the connected Browser Source updates without changing its URL. A previously copied `?theme=` URL deliberately keeps its explicit look; remove that one override if the source should follow saved changes. Persistent/self-driven widgets keep their own visibility, and test events remain capped at 20 seconds. The previous browser theme banner only fills a draft; opening Settings never silently writes it to a token.

# Widget playground

No additional owner configuration is required. The normal API image includes the shared sample JSON; deploy API and web normally. Use Settings → Overlay → Widgets → Preview, Stream Studio or the public playground to inspect silent local sample data before using Test in OBS. The playground uses no account or overlay token and makes no provider request. No production integration or account setting was changed while validating it.

# OBS game sources and website requests

No new environment variables, secrets, indexes or services are required. Deploy
the normal API/web changes; native source support requires a future ordinary
agent update. Older agents keep Copy/Drag and show Add as unavailable. No native
installer, version bump, signing or release is part of this work.

Website requests are off by default in the agent. The user saves OBS connection
details and explicitly enables **Allow website requests to add an OBS source**.
Every Add still needs a default-Cancel desktop confirmation for the current
program scene. Never retry an uncertain acknowledgement without inspecting OBS.
Ghost assignments remain Copy/Drag; the optional builder source explains its
required URL setup. See `/help/obs-auto-scene-switching` and
`docs/obs-auto-scene-switching.md` §§5/7 for the complete procedure. Validation
used disposable fixtures and fake/offscreen OBS boundaries; no production OBS or
account integration was run.

# Chat commands v2

No new environment variable, secret, collection, index, migration or paid
service is required. Deploy the API and web together. In Settings → Overlay →
Multi-platform chat → Chat commands, explicitly open the editor, choose
availability/alias/cooldown and Save. Custom replies allow only `{user}`,
`{mmr}`, `{record}`, `{opponent}` and `{streak}`. Try shows the saved command's
exact reply with the selected existing overlay token and never sends it.
Copy Nightbot snippet copies that token's private credential URL; paste it
only into the intended bot configuration. Existing integration switches remain
off until the owner enables them separately. No account was enabled or used to
publish a message during implementation.

The record is a UTC calendar day, and uptime is time since Start new session,
not a claim that Twitch has been live. Season replies need an already-cached
current regional season boundary; a cold/unavailable catalog gives an honest
unavailable line without starting provider traffic. History replies can be
up to30seconds old and disclose safety-limited cohorts. Chat and on-stream
cooldowns run independently so each surface can answer the same viewer once.


# Public auth return paths

Auth return-to-context needs no new environment variable, secret, Clerk
dashboard change, migration, index or paid service. Deploy the normal web
change after Ghost's account-assignment API. Existing Clerk keys are reused.
Public sign-in links carry a validated local destination; new accounts see it
through setup. An explicit public Save/vote/Practice choice is remembered only
in the originating browser tab for fifteen minutes. Blocked browser storage or
an expired choice requires pressing the original action again. Practice uses
the existing Ghost source URL and opens Settings → Overlay after confirmation.
Validation uses local synthetic auth/API boundaries; it does not create an
account, save production preferences or enable a provider.

# Stream Dock Game desk

Deploy API and web together, then refresh existing Dock and overlay Browser Sources once so their game-widget hiding and manual-result labels update. No environment variable, service, collection, index or migration is added. Game is the first Dock section; its sticky header keeps scene, active opponent, session and connection visible. Current desktop agents omit the live map, so that field correctly says unavailable.

At stream start, confirm Start new session to reset the account's session boundary and this token's clip timestamp mark. Hide game widgets is reversible and keeps chat/scenes running; verify your refreshed sources hide and resume before relying on it live. Crystal Ball manual/cancel controls never award points or accuracy. Shout-outs use only reviewed exact opponent channels; a configured matching Twitch bot queues them, otherwise Copy shout-out is available. Validation used synthetic loopback data and no actual bot or provider posts.

## Series mode (Wave 4)

Deploy API and web together, then refresh existing Dock and overlay Browser
Sources. No environment variable, collection, index, job or provider connection
is added. In the Dock's Series section, choose an opponent, best-of format and
optional ordered maps, then explicitly Start. In Settings → Overlay → Widgets,
enable Series for All-in-one or copy its dedicated 640×420 Browser Source.
It starts off and stays transparent until a series exists.

Automatic scoring requires a matching replay with a recorded exact start after
Start. Old uploads without that field remain manual-only; known account
mismatches never fall back to a shared name. Use ±1 to correct a score and End
to stop scoring. Eighty retained replay receipts pause automatic scoring until
the next Start. Lifetime H2H is unavailable without an exact recorded account.
The shared Chat commands editor controls `!series` aliases, platforms and
cooldown; no bot is enabled and no message is posted automatically.

Use the silent local preview or Test in OBS to inspect the scorecard; tests do
not start or score a series. Roll back by ending the series and disabling its
widget, then reverting the feature commit if needed. Stored Studio state can
remain safely bounded. Implementation verification uses synthetic local owners,
replays and socket traffic only.

## Game moment alerts (Wave 4)

- No new environment variables, collections, indexes, migrations or provider connections.
- All nine moments and bot posting start off. Settings → Overlay → Multi-platform chat → Game moments uses the existing draft and Save chat settings action. Test locally is silent unless a sound is selected, previews only this browser, and writes no preference.
- Existing Event alerts Browser Sources need one refresh for the new Ladder queue. Saved event sound enable/volume and OBS audio routing still apply. Supporter cards have priority; paused game widgets consume Ladder events without replaying them later.
- Comparative facts use one bounded slim replay read and exact account/race context. Recorded MMR is game-start MMR. Current regional season data is cache-only; missing/incomplete evidence suppresses a season peak. Only actual Pulse league snapshots establish league changes.
- A conditional receipt on the existing game row prevents duplicate posts on reprocessing. Historical imports, resumed, hidden and deleted games do not create moments. Delivery is best effort after the receipt, so a crash can miss an alert rather than repeat it.
- Rollback: turn moments and bot posting off in Settings, Save, then revert the feature commit if needed. Existing receipts are harmless; do not remove them to replay history.

## Unified build editor (Wave 4)

- Web-only deployment. No new environment variables, API schema, collection,
  index, migration, provider connection or native release is required.
- New build and the first-run cards open the same rich editor used by replay
  capture and saved-build editing. Definitions has an explicit private-variant
  link. The pasted-build card stays unavailable until reference build orders.
- The game picker reads 20 visible replays per cursor page with the existing
  matchup/build filters, then loads only the selected build order. Detected
  variants follow stored effective labels, including confirmed check-ins.
- After changing unit/icon metadata or the explicit upgrade list, run
  `npm run build-tokens:gen` from `apps/web`. The catalog test checks that its
  402 known actions stay reproducible. Existing structural rule readers keep
  legacy data; the editor requires correction of unknown draft actions before
  preview or Save. Existing signature builds retain their signature until rules
  are added, and private notes/publication settings keep their existing flow.
- Optional editor code loads when opened. A stale chunk gets local Retry and
  Cancel controls; Retry does not repeat replay selection or write anything.
- Rollback is a web revert. No stored data conversion needs to be undone.

### Reference build orders (ADR 0058)

- No environment variables, new infrastructure, collection, index, migration,
  provider setup or desktop release. Existing custom-build documents may carry
  an optional version-1 `buildOrder`; old documents remain valid.
- Deploy the API field validation/projections with the web editor. Source
  replay IDs remain private in nested reference data; shareable step notes are
  distinct from private build notes. Lists and classifier pages omit full
  reference payloads. A card requests its reference only on explicit Practice.
- Paste parsing and exports run locally. No external parser or AI service is
  used. Rollback may leave the optional field stored; older readers ignore it.

## Optional public Community cache (ADR 0056)

No environment value, integration, collection, index, migration or provider is
enabled by this change. API `COMMUNITY_REVALIDATE_URL` and the shared server-only
`COMMUNITY_REVALIDATE_SECRET` in API/web are optional and must be configured
together later by the owner. See `docs/DEPLOYMENT_GUIDE.md` for the exact signed
protocol and local validation. Unset API configuration sends nothing; unset web
secret keeps user-derived public reads/share cards uncached. General configured
Community data uses300-second tags; best-effort purge has no guaranteed seconds
to visibility. Opponent API/fetch/page always remain no-store, with a bounded
one-hour service LRU behind fresh floor/removal admission. No six-hour rendered
opponent cache is enabled. Rollback is a source revert; no data conversion or
production mutation is required.

# Appearance and accessibility

No new environment variables or account setup. Existing Light/Dark choices
remain valid; System follows the device when no choice is stored. Appearance
controls and Help explain keyboard use. The public statement records the
WCAG 2.2 AA target and known limits. CI installs pinned axe tooling, checks the
actual CSS contrast matrix and scans public pages in both themes. Exact
exceptions need a reviewed reason; the initial exception file is empty.
