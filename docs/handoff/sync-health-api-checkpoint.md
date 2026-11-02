# Sync health API: checkpoint (roadmap item 76, PR B, API slice)

This slice is the API half of "Sync health everywhere". The agent can now send
a small sync report in its heartbeat. The API cleans it, stores it on that PC's
device row, and turns it into health rows. Ingest counts the agent's rejected
uploads. A new route, `GET /v1/me/sync-health`, returns the rows. The Doctor
adds the same rows as warnings with a help link.

No agent or web code changed. Old agents send no report, and nothing changes
for them. Nothing is committed yet.

## Heartbeat sync contract

The agent may add `sync` to the body of `POST /v1/devices/heartbeat`. Every
field is optional. The whole block must fit in 2048 bytes of compact UTF-8
JSON, both as sent and after cleaning.

| Field | Type | Rule |
| --- | --- | --- |
| `pending` | integer | Replays waiting to upload. |
| `archivePending` | integer | Replay files waiting to archive. |
| `paused` | boolean | The user paused syncing. |
| `foldersWatched` | integer | Replay folders being watched. |
| `missingFolders` | integer | Configured folders that no longer exist. |
| `lastUploadAt` | ISO 8601 string | Last successful upload. |
| `lastErrorCode` | string | Code of the latest failed upload. Omit it after the next success. |
| `skipped` | object | `{ reason: count }`, see the reasons below. |
| `rejected` | integer | Uploads the server rejected (agent's own count). |
| `filtered` | integer | Replays outside the sync range. |
| `unresolvedNames` | array | `[{ name, toonHandle, count }]`, at most 10. |

Cleaning rules (`apps/api/src/services/syncReport.js`):

- Counts must be numbers. They are truncated and clamped to 0..999,999.
- `lastUploadAt` must look like ISO 8601. It must fall between 2010 and one
  day after the server clock. Otherwise it is dropped.
- `lastErrorCode` must match `^[a-z][a-z0-9_]{0,47}$`.
- `skipped` keeps only these reasons, with counts above zero: `ai_game`,
  `resumed_replay`, `player_unresolved`, `no_result`, `parse_failed`,
  `analysis_failed`, `file_unstable`, `playback_budget_exceeded`, `unsupported_replay`.
- Each unresolved name needs a trimmed name of 1 to 32 characters with no
  control, bidi or lone-surrogate characters, a toon handle matching
  `^\d+-S2-\d+-\d+$` (32 characters at most) and `count` of at least 3. Only
  the first 10 entries are read. Duplicate toon handles are dropped.
- Unknown keys are dropped at every level. The cleaned report is rebuilt with
  fixed keys, so no stored key can start with `$` or contain `.`.
- A block that is not an object, has no valid field, or is too large is
  dropped. The heartbeat still answers 200 and still advances `lastSeenAt`
  and the other metadata.

The response gains `syncAccepted: true` or `false` only when the body had a
`sync` key. Old bodies get the old response, `{ receivedAt }`.

The agent should send the full block on every heartbeat. Counts should be the
current state, not lifetime totals, so a warning clears once it is fixed.

## What is stored, and who can read it

- The device row (`device_tokens`) gets `sync` (the cleaned report) and
  `syncReportedAt` (the server's receive time). Both are written in the same
  single heartbeat update as `lastSeenAt`. A `$cond` keeps a stored report
  that is newer than the request, so a delayed heartbeat never rolls it back.
  A heartbeat without `sync` leaves both fields as they are.
- The fields are metadata under ADR 0072. They are listed in the writer
  inventory test and in the ADR. No credential read projects them.
- `GET /v1/devices` (`listDevices`) returns `sync` and `syncReportedAt` to the
  owner. It is the stored report, even when it is stale.
- `GET /v1/me/sync-health` returns a report to its owner only while it is
  current (see below).
- `GET /v1/me/export` already exports whole device rows, so the owner's own
  export includes the report.
- The admin support snapshot does not show reports. Its device list keeps its
  explicit fields. Support sees only the Doctor's count-only warnings.
- Unresolved names and toon handles never reach Doctor messages, logs, the
  support view or error text.

## Ingest rejection counters

`POST /v1/games` now makes one best-effort update per batch, after the loop
and before the 202 (`apps/api/src/services/ingestRejections.js`,
`apps/api/src/routes/gamesIngestPolicy.js`).

- Each rejected game maps to a closed code: `validation_failed`,
  `game_deleted`, `quarantine_failed`, `upsert_failed`,
  `custom_build_tag_retry_required` or `quarantine_repair_failed`. A counter
  key never comes from request text.
- Only device-token (desktop agent) uploads count. The browser importer
  already shows its own per-file failures.
- Retryable rejections are not counted. They are transient server failures.
- `game_deleted` is not counted. It is the owner's own deletion.
- The users row keeps one 7-day window:
  `ingestStats: { rejected: { <code>: n }, rejectedSince, lastRejectedAt }`.
  A batch inside the window adds to the counts. The first batch after it
  starts a new window. `lastRejectedAt` only moves forward.
- The update never upserts, so a missing user is a no-op. A failure is logged
  with codes and counts only. The 202 body never changes.

In practice only `validation_failed` is counted today. The other codes are in
the closed set so later non-retryable codes need no schema change.

## Rules

`deriveSyncHealth({ devices, ingestStats, release, now })` in
`apps/api/src/services/syncHealth.js` is pure. A device rule reads only a
current report: `syncReportedAt` at most 5 minutes old. Old agents, offline
PCs and stale reports add nothing. Rows come in rule order, then device order
(most recently seen first).

| Code | Severity | Fires when | Count | helpSlug | fix |
| --- | --- | --- | --- | --- | --- |
| `agent_no_folders` | warn | `foldersWatched` is 0 | `missingFolders` (0 if none set up) | `desktop-app-status` | `add_folder` |
| `agent_paused` | info | `paused` is true | `pending` | `desktop-app-status` | `resume` |
| `agent_upload_failing` | error | not paused, `lastErrorCode` set and `pending` > 0 | `pending` | `desktop-app-status` | `retry` |
| `agent_outdated_required` | warn | agent version is below the release's `minSupportedVersion` | 1 per PC | `desktop-app-status` | `update_agent` |
| `replays_skipped_unresolved` | warn | `skipped.player_unresolved` > 0 | that count | `my-game-didnt-show-up` | `add_identity` |
| `uploads_rejected` | warn | the last counted rejection is under 7 days old | the window's total | `my-game-didnt-show-up` | `report` |

Device rows carry `deviceId`. The `uploads_rejected` row is account-wide and
has none. `fix` names the action a client should offer. It is a closed set:
`add_folder`, `resume`, `retry`, `update_agent`, `add_identity`, `report`.

The release floor comes from `agentVersion.latest()`. It is looked up only
when a current report exists, for the platform of the first such PC. The
service is feature-detected and the lookup is best-effort. A missing service
or a failed lookup means no `agent_outdated_required` row.

## Route: `GET /v1/me/sync-health`

- Auth is applied on the route, like the other `/me` routes.
- `Cache-Control: private, no-store` on every answer.
- Any query string is refused with 400 `sync_health_query_invalid`, before
  any read.
- It makes one users read: the Doctor snapshot, whose projection now includes
  `ingestStats`. It reads the owner's devices once. A profile error on that
  read (GDPR busy, invalid stored session gap) answers 503, as the Doctor does.

Response:

```json
{
  "checkedAt": "2026-11-01T12:00:00.000Z",
  "reported": true,
  "rows": [{ "code": "agent_paused", "severity": "info", "count": 2,
             "deviceId": "…", "helpSlug": "desktop-app-status", "fix": "resume" }],
  "devices": [{ "deviceId": "…", "label": "…", "hostname": "…", "agentVersion": "…",
                "lastSeenAt": "…", "reported": true, "syncReportedAt": "…", "sync": { } }],
  "rejections": { "count": 2, "byCode": { "validation_failed": 2 },
                  "since": "…", "lastRejectedAt": "…" }
}
```

`reported` is false when no PC has a current report. That is the "not
reported by this app version" state. A device gets `syncReportedAt` and `sync`
only while its report is current. `rejections` is null outside the window.

The route is listed in the `me.js` route comment and the API README table.
The API has no OpenAPI file, route registry or route budget.

## Doctor warnings

`buildDoctor` appends one warning per code after the original four, with
counts summed across PCs. The original four (`no_profile`, `no_agent`,
`no_games`, `replay_archive_incomplete`) are byte-identical. A new warning is
`{ id, severity, message, cta?, helpSlug }`. Messages hold counts only, never a
player name, toon handle or PC name. `agent_outdated_required` links to
`/download`. `replays_skipped_unresolved` links to the profile settings.
`agent_paused` is info, so it does not change `ok`.

## Pinned tests changed

- `deviceCredentialWriterInventory.test.js`: `sync` and `syncReportedAt` join
  `METADATA_FIELDS`. The pinned `update`/`fields` shape and the writer list
  are unchanged. The guarded values ride in the same `$set` stage as
  `lastSeenAt`, because `fields` wraps every value in `$literal` and cannot
  hold a guard.
- `userReadSnapshots.test.js`: the Doctor snapshot DTO gains `ingestStats`
  (null when absent) in three exact assertions. The projection check now
  expects `ingestStats: 1`. A new case checks the closed-code rebuild.
- `dashboardMaintainedReads.replset.test.js`: unchanged. It still sees exactly
  one users read, because the projection grew instead of a read being added.
- ADR 0072 line citations for `services/devicePairings.js` and `routes/me.js`,
  and ADR 0073's `routes/me.js` citation, moved with the code.

## Verification

All runs used the repo's jest wrapper on cached mongod 7.0.14:
`node C:/SC2TOOLS/.cache/faster-dashboards-tools/run-b76api-jest-01.mjs <label> <paths>`.

- Final run `b76-final-01`: 30 suites, 480 tests, all pass. It covers the six
  new suites and every pinned or related suite: device pairings and liveness,
  the writer inventory, the Doctor read costs, the support snapshot, me routes,
  ingest and admission, notifications and agent connection events.
- Run `b76-final-02`: 15 more heartbeat, overlay, ingest and GDPR suites,
  257 tests, all pass.
- `tsc --noEmit -p tsconfig.json` in `apps/api`: exit 0.
- ESLint on every changed and new file: no new warning. The existing size
  warnings keep their counts, except the games router (633 to 629 lines) and
  its ingest handler (459 to 455), where one call was folded onto one line.
- `apps/api/data/ladder-map-pool.json` was not rewritten.

## What the agent slice still needs

- Send `sync` on every heartbeat, under 2 KiB, with current counts.
- Send `lastErrorCode` only while uploads are failing.
- Keep the skip reasons in the list above. `filtered` is not a skip reason
  here; it has its own count.
- Send `unresolvedNames` only for names seen 3 or more times, at most 10.
- Read `syncAccepted: false` and log it once. Older APIs never send it.
- A reason-scoped resync command does not exist yet. The server can only
  send a full `resync:request {reason}`. "Retry with latest agent" needs a
  new command that names the reason or paths, and agent support for it.

## What the web slice still needs

- Types for `GET /v1/me/sync-health`, for `sync`/`syncReportedAt` on
  `/v1/devices`, and for `helpSlug` on Doctor warnings.
- A "not reported by this app version" state when `reported` is false and
  the PC is online.
- Titles for the six new Doctor ids. Until then, Setup health shows them as
  generic "Setup check" rows. DoctorBanner keys warnings by id; the Doctor
  sends one warning per id.
- DoctorBanner does not re-poll, so a warning can stay up after a fix until
  reload.
- `agent_outdated_required` can duplicate the Today upgrade notice.
- "Add as my account" needs a narrow route that adds one toon handle
  (`users.addPulseId` exists but is internal). It is not in this slice.
- A web test that checks API help slugs. This slice's API test checks that
  both slugs exist as web articles.

## Not done

- No add-one-identity route and no reason-scoped resync command.
- No compact sync summary on `GET /v1/me`. Its DTO is pinned. The header pill
  can load `/v1/me/sync-health` when its popover opens.
- No "agent offline for 24 hours" warning. None of the six codes covers it.
- The release floor is null for GitHub-only releases, so
  `agent_outdated_required` (like the existing `agent.update_required`
  notification) fires only when a stored release sets `minSupportedVersion`.
- Rejected game ids are not kept, so a fix cannot target those games.
- Nothing is committed, pushed or deployed. The API should ship before the
  agent and web slices.
