# Personal notification center

The authenticated `/v1/me/notifications` router is always available. Review rollout flags gate review producers, not the inbox. Both normal web shells render the bell for signed-in users; overlay and Dock token surfaces keep their existing isolated UI.

Notifications remain in the existing collection with its 90-day TTL. The server emits only `notifications:changed {kind}` to the user's room. Text and destination URLs are read through authenticated, user-scoped REST endpoints. The web keeps its slow polling recovery. There is no email send. Optional delivery channels (Web Push, Discord webhooks) and the reports are described in [Reports and delivery channels](#reports-and-delivery-channels); none adds a scheduler, queue service or paid provider.

## Event delivery and grouping

`NotificationsService.notify()` reads only the recipient's notification preferences and skips muted kinds. Event-driven producers pass an `eventKey`, and producers that fold distinct deliveries into one unread row also pass a `groupKey`. The unique `(userId, deliveryKeys)` multikey index prevents retries from incrementing a group or creating another row after it was marked read. Delivery keys are not serialized to clients. Retention bounds their lifetime to the existing notification lifetime.

| Producer | Kind | Delivery identity |
| --- | --- | --- |
| Completed desktop import | `import.done` | Import job ID |
| Authenticated heartbeat below the release's minimum version | `agent.update_required` | Minimum supported version |
| Positive community vote transition | `community.vote` | Voter, build slug and UTC day; grouped per slug/day |
| Report status or reply | `support.status`, `support.reply` | Report ID and admin action request ID |
| Existing coaching mutation emit points | `coaching.booked`, `coaching.cancelled`, `coaching.assigned`, `coaching.practice_sharing_*` | Booking, assignment or sharing-request identity and event kind |

Import completion uses the authoritative job's `completed` count and says **games synced**. That metric includes successful reuploads; calling it newly added games would be inaccurate. No desktop protocol or GUI change is needed. Cancelled, failed or stalled jobs do not create a completion notification. There is no scheduled “agent offline” notification.

## Support round trip

Reports remain `user_message` admin events. `GET /v1/messages/mine` returns only the signed-in sender's latest 20 reports, status and replies, with an explicit public projection. It excludes admin identity, account email, Clerk IDs and attached diagnostics. The Settings Help tab renders this history.

Admins update a report through `PATCH /v1/admin/messages/:eventId` with `{expectedRevision,requestId,status?,reply?}`. Status is `new`, `looking`, `fixed` or `wontfix`; replies are limited to 2,000 characters. Compare-and-set revision checks protect concurrent edits. Reusing the same request ID retries the original action and its notification delivery; conflicting reuse is rejected. Each report holds at most 50 actions. The admin UI preserves reply drafts on failure. Email-only reports have no in-app reply recipient.

## Preferences and UI

`GET/PUT /v1/me/preferences/notifications` stores `{muted: string[], milestones: boolean}` separately from Misc and onboarding preferences. Settings Misc has per-kind controls and a single Milestones opt-in. Missing milestone consent defaults to off. Muting affects future deliveries only.

Private `moment.*` rows appear under **Milestones**. Each links to the owner's
game and uses `gameId:kind` as its event key. Delivery requires a newly inserted,
fresh competitive game, an owner/game receipt and current opt-in. The bell
stores a separate row for each qualifying milestone and skips muted kinds.
An interrupted write remains pending on the private game receipt and can finish
on a fresh reupload. The event key deduplicates retries.
The shared socket room gets a generic refresh ping. Only the authenticated
inbox response includes the milestone kind and details.

The bell preserves its cursor and read-acknowledgement behavior. Its presentation is loaded on demand to protect route budgets. Opening marks visible rows read but retains their per-open New tint. Unread/All is a visible segmented control, categories filter loaded rows, and the full `/notifications` page uses server-side category filtering plus compound cursors. Focus enters the first row or empty header and returns to the bell on close. The bell remains available on count errors with Retry. Coaching alerts and build check-ins remain actionable queues and use the same compact chip/badge visual treatment.

## Reports and delivery channels

Everything below runs on the API's existing in-process timers (`jobs/deliveryJobs.js`, the `reviewDigestJob` pattern registered with the job ledger). Every unit of work is idempotent by itself, so a deploy restart or a brief two-instance overlap cannot double-send.

| Job | Interval | Work | Idempotency |
| --- | --- | --- | --- |
| `reports` | 1 h (first run 5 min after boot) | Resume pending stream reports, close streams idle for four hours, then deliver due weekly reports | Stream closure persisted before clearing `users.streamSession`; expiring `users.reports.weeklyClaim` per ISO week, `weeklyWeek` records completion; notification keys `report.stream:<id>` / `report.weekly:<week>` |
| `discord-outbox` | 30 s (only with webhook storage) | Drain ≤20 due posts; session summaries every 5 min | Unique `dedupeKey` per hook and event; per-row claim before posting; `jobLock` single flight |
| `coaching-reminders` | 5 min | Reminders 24 h and 1 h before booked sessions | Notification key `coaching:reminder:<booking>:<window>` |

### Weekly report

`services/weeklyReport.js` builds a local ISO week (Monday 00:00 to Monday 00:00 in the report time zone, DST-correct) next to the week before from slim `games` rows: totals, hours, sessions (session gap policy), W-L by matchup with last week's counts, MMR per account and race, best and worst map and build (at least three decided games), the top three opponent strategies with the owner's record, and average macro score and most frequent leak (at least three games). Facts only. `GET /v1/reports/weekly?week=YYYY-Www&tz=Zone` serves the owner; `week` defaults to the last complete week. Delivery is due from Monday 09:00 to the end of Wednesday in `preferences.reports.timezone` (UTC until saved); weeks under five games complete without a post, and `preferences.reports.weekly=false` opts out. An expired claim can be retried during that delivery window. The bell key and Discord receipt allow a worker to resume after a partial delivery. Candidates come from one bounded aggregation over the global `games.createdAt` index per week, cached for six hours.

### Stream reports

The Dock's **Start new session** opens `users.streamSession`. **End stream**, a new session, or four quiet hours closes it. The original closure time is saved before clearing the open stream. If a build or notice is interrupted, the hourly job resumes it. The newest 100 finished reports per owner are kept in `stream_sessions` (≤5 kB each). A report includes record, matchups, maps, builds, MMR start/end/peak, best win by opponent MMR, randomizer games, verified Crystal Ball results, anonymous top-five supporter and oracle counts, and up to eight clip moments. The owner can attach a Twitch or YouTube recording with timestamp links.

The owner can publish each report at `/players/<slug>/streams/<public-id>` while the public player page and stream reports are enabled. The public response includes date, record, time played, MMR change and matchup counts. It omits clip notes, recording URLs and opponent or viewer data. The owner can revoke one address. Turning off the public player page or stream reports invalidates every address created before that change. The public page and image check current eligibility on every request.

### Web Push

`services/pushNotifications.js` with `services/webPushCrypto.js` (RFC 8291 `aes128gcm` encryption and RFC 8292 VAPID on `node:crypto`, pinned to the RFC 8291 Appendix A vector in tests; no dependency). `NotificationsService` fans out every stored row to the owner's devices for the push groups they chose (muted kinds are never stored, so never pushed). Endpoints must be a browser push service over https (FCM, Mozilla, Apple, Windows); devices answering 404/410, or 401/403 after a VAPID change, are removed. At most ten devices per account. The service worker shows the notification with a same-site destination only, focuses or opens a tab on click, and re-registers a rotated subscription through `POST /v1/push/subscription-change` (the old endpoint proves ownership). Inert until `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` and `WEB_PUSH_VAPID_SUBJECT` are set; `node scripts/generate-vapid-keys.js` in `apps/api` prints a pair.

### Calendar feed

`GET /v1/calendar/<secret>.ics` serves booked and cancelled sessions from 30 days back to a year ahead: a coach sees "Coaching session" without student names, a student their own sessions with the coach's name. Feed requests look up the SHA-256 of the 256-bit secret (`users.calendarFeed.hash`). With `PLATFORM_TOKEN_ENCRYPTION_KEY` configured, newly created links also store an owner-bound AES-GCM copy for account export after signing in directly. Settings shows the new link once. **Regenerate** replaces the link and **Turn off** removes it. Request logs redact the path segment. Each booking card also offers a client-side one-event `.ics` file.

### Discord

`services/discordWebhooks.js`. The user pastes up to three webhook URLs; only `https://(canary.|ptb.)discord(app).com/api/webhooks/<id>/<token>` is accepted, stored AES-GCM encrypted with `PLATFORM_TOKEN_ENCRYPTION_KEY` through the platform credential vault helpers (bound to owner and hook), and shown, exported and logged only by its last four characters or hook id. Request bodies carrying a webhook URL or push endpoint are kept out of Sentry. A hook starts off and can be switched on only after its posts were previewed. Events: ranked results (ingest enqueues only), session summaries (after the session gap), weekly recap, MMR peaks (at least 20 prior rated games) and promotions. Promotions require a higher observed league in consecutive ranked 1v1 replays for the same account and ladder race. The agent includes the league only when the replay records it. Opponent names off, MMR on and public replay links off by default; `allowed_mentions` is empty. The drain honours 429 `retry_after`, backs off exponentially on 5xx and network errors, gives up after five attempts, and disables a hook after three consecutive 401/404 answers with a notification to its owner. Outbox rows expire after 7 days. Delivered weekly recaps and promotions leave a deduplication receipt with the message removed. Nothing is sent while the account is being erased. Without the key the card says the feature is unavailable.

The battle report Discord post (headline and paragraph) has a template (`battleReportMessage`) but no producer: it waits for a public battle-report link.

### Privacy and erasure

`stream_sessions`, `discord_hooks`, `discord_outbox` and `push_subscriptions` are purged with the account and never restored from snapshots. The account export includes stream reports, push devices (endpoint and keys), Discord hook metadata and the current calendar secret when the owner signs in directly and its encrypted copy is available. Desktop-device exports include the link metadata. Older hash-only links keep working and can be regenerated to include the active secret in a future export. Calendar credentials are never restored from a backup.

