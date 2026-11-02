# Sync health fix actions: checkpoint (roadmap item 76, B3)

This worktree prepares the API and private Settings controls. The agent
handler and saved-toon resolver are **not implemented by this phase**. They
must be added after B1 (#865) merges, using its reviewed parser side channel
and both runner modes. Old agents explicitly report unsupported through the
API and never receive the legacy full-resync event from these buttons.

## Owner actions

`POST /v1/me/sync-health/identity` accepts exactly `{toonHandle}`. It requires
a Clerk owner session, rejects query parameters, uses the report's 32-character
toon format and replies with `{code: added|already_present, count}`. Capacity
(20), missing owner and concurrent/GDPR contention have distinct errors. The
route never accepts a caller's owner ID, profile replacement, name or path.

`appendPulseId` is also used by existing ingestion/detection appends. A bounded
compare-and-set compares the exact old identity fields, retries a concurrent
change and writes only `pulseIds`, its legacy first-entry mirror `pulseId`
and schema version. Explicit arrays, including empty ones, take precedence
over the legacy singular field. Concurrent additions cannot overwrite one
another or exceed the cap. A concurrent explicit profile replacement retains
its existing semantics, ordered before or after the atomic append; no unrelated
profile field is rewritten. Identity database failures become a fixed error
before the shared error logger can see private filter values.
The two exact action POSTs also have a 1 KiB JSON parser before ordinary
parsing. Malformed/oversized/unsupported-encoding input becomes a fresh fixed
`sync_fix_invalid_json` error without the original message, body or cause,
so the shared error logger and 4xx reply cannot expose submitted identity text.
Unrelated routes keep their existing parser and body limits.
The existing optional Sentry body exclusion also recognizes these exact action
paths before parsing. Its event and transaction callbacks strip both request
copies, including a URL-less copy when the other copy identifies the action.
No SDK initialization, provider settings or incoming-span policy changes.

`POST /v1/me/sync-health/retry` accepts exactly `{deviceId, reason}`. The closed
reason list is `player_unresolved`, `parse_failed`, `analysis_failed`,
`file_unstable`, `playback_budget_exceeded`, `unsupported_replay`. It excludes
the date filter and intentional AI/resumed/no-result skips. It requires the
Clerk owner session, selects one authenticated device in that owner's room,
checks its current token/device/owner binding before dispatch and after ACK,
and requires the same live namespace session after ACK. Web/overlay/foreign
sockets cannot receive it. Presence and credential reads each have a one-second
deadline; command ACK has a real ten-second deadline and no fallback/retry.
Expiry is checked at ACK and after the final ownership read.

Responses are private/no-store and contain only `code`, `count`, `requestId`
and `deviceId`. Accepted means queued, not uploaded. Offline, unsupported,
pending, expired, malformed ACK and unknown outcomes remain distinguishable.
The server retains per-owner admission until actual settlement/deadline,
limits pending owners to 64 and rate-limits retry to 6/minute and identity
changes to 20/minute in cardinality-bounded stores.

## Socket contract for the later agent phase

1. An agent that implements this contract advertises integer
   `syncRetryVersion: 1` in its authenticated device handshake. This is a
   protocol capability, never a persisted setting or feature flag. Other
   values are unsupported. Web and overlay handshakes cannot advertise it.
2. After connection, the server sends only that capable authenticated device
   `sync:retry-ready {version:1, deviceId, sessionId}`. Keep this advisory
   binding in memory, tied to the token/owner/connection epoch. No persisted
   `deviceId` or credential schema change is needed. `sessionId` is the Socket.IO
   namespace SID (`AsyncClient.get_sid(namespace='/')`), **not** the Engine.IO
   `AsyncClient.sid`. Clear the binding immediately on disconnect, stop,
   token replacement or owner change.
3. The **new** event is `sync:retry-request` with exactly
   `{requestId, deviceId, sessionId, reason, expiresAt}`. `requestId` is 32
   lowercase hex characters; `deviceId` is 24 lowercase hex; expiry is Unix
   milliseconds, at most 15 seconds ahead. Validate strict fields/types,
   capability, current binding/namespace SID, token/owner/connection epoch,
   expiry and the closed reason set before local work and before ACK. Never
   route it through `resync:request`, whose old handlers clear the full cursor.
4. The bound ACK is `{requestId, deviceId, sessionId, reason, code, count}`.
   `count` is an integer 0..999999 (zero unless accepted), with no names/handles/paths/errors. Codes:
   `accepted`, `no_matches`, `busy`, `expired`, `owner_changed`, `unsupported`,
   `invalid_request`, `local_error`. API strips all other ACK fields. Cache
   bounded request IDs for duplicate-command idempotency until expiry. A lost
   ACK has an unknown result; the server never automatically dispatches again.
5. Keep socket heartbeats responsive: run profile/filesystem/queue work via
   the existing background/thread mechanism. For `player_unresolved`, refresh
   usable owner-saved toon identities, then use B1's scoped side channel to
   resolve the exact saved toon and parse with that replay player's display
   name. A stale profile display name and a second saved toon must recover in
   both thread and process paths without changing parser signature, two-tuple
   return or canonical Pyodide outputs.
6. Retry only current matching local cursor records via a narrow queue policy,
   preserving successful, missing, pending, unrelated and date-filtered work.
   Extend the existing explicit retry allowlist only for the six reasons
   above. Preserve capture/engine opt-in. Lock state consistently with B1's
   `_STATE_SAVE_LOCK`, avoid lock inversions, save once with rollback on failure,
   request a watcher sweep and refresh recent-history/health facts. All new
   callbacks must survive token replacement in GUI and headless modes.

The ready signal is advisory; current token authentication and post-ACK
presence are authoritative on the API. An agent must not treat ready alone
as permission after its connection epoch changes. Test stopped/owner-changed
fences during held refreshes, duplicate IDs and expiration before any mutation.

## Private web controls

Only the lazy Settings Sync health card imports the controls. Unresolved
entries offer **Add as my account**, with busy/idempotent/capacity recovery;
the PC's unresolved row and permitted other-skip reasons offer **Retry with
latest agent**. Controls serialize actions within the card. Feedback provides
offline, update, busy, account-change and uncertain-result recovery and never
echoes raw errors. Accepted retry copy explicitly says queued and retains the
sync date range. Check again remains the explicit way to inspect later results.

Actions use the shared owner/JWT/body deadline, abort on unmount and fence
owner transitions including A-B-A. Only the current owner's existing profile
and sync-health SWR keys revalidate after success. There is no mount-time
write, polling or new GET `/me`. Header, Devices and Report remain count-only;
player names and handles remain within the owner's Settings list. The lazy
section shell and existing maintained-read contracts are unchanged.

## Verification status and required follow-up

Source JavaScript syntax checks, UTF-8/control-byte scan and `git diff --check`
passed during this phase. Independent API/web source review and refuting
verification identified existing callback warning growth, raw JSON parser
errors and optional telemetry body capture. The capability/ready helpers,
fixed-error pre-parser and telemetry exclusions address those findings.
The follow-up source review is clear; final refuting follow-up and runtime
gates remain pending. **No runtime tests, typechecks, lint, build or mutation
checks have run for this change yet.** The root owns the serial check gate. No agent source,
configuration flags, dependencies, infrastructure, production data or native
process was touched by this phase. Agent 0.24.8 remains unpublished and
owner-gated; this checkpoint is not installed-agent acceptance.

New tests cover real Mongo append races, cap/duplicates/legacy/profile/GDPR,
strict owner request bodies, current session and revoked credentials, deadline
and expiry paths, bounded admission/rate limits, ACK privacy, exact new event,
capability/ready isolation, web scoped POSTs/cache invalidation, busy/error/
offline/update recovery, no automatic retries and held JWT/body retirement.
Run these plus `syncActionJson`, `privateSearchSentry`, `meProfile`,
`meSyncHealth`, `socketAuthWeb/Overlay/Obs`,
`dashboardMaintainedReads.replset`, Settings SyncHealthCard, syncHealth helpers,
header/Devices/privacy/help neighbours, API/web types/lint/UI lint, full web
gate and route budgets. Add reason/owner/session/expiry/atomic-append mutation
checks. Agent integration needs its own review/verifier and queue/parser/
socket/boot/parity tests after #865 merges, then combined final-head checks.

Preserve all 40 canonical engine inputs, seven served assets, four strict
samples, 49 raw pins and 83 route budgets. Do not regenerate those for this
API/web phase. Do not publish, tag or rebuild agent 0.24.7/0.24.8.
