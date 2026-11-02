# Sync health fix actions: checkpoint (roadmap item 76, B3)

The API, private Settings controls and native handler are implemented in this
worktree, after B1 (#865, exact source `647ee82e`) merged as `da77a84b`.
Native source review and combined runtime gates remain pending. Old agents
explicitly report unsupported through the API and never receive the legacy
full-resync event from these buttons. Agent 0.24.8 remains unpublished and
owner-gated; this is not installed-agent acceptance.

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

## Socket contract and native implementation

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
5. `SyncRetrySocket` runs the controller in a background thread, reserving
   the request ID before dispatch. Exception/cancelled ACK outcomes retain a
   fixed uncertain result, and admission stays occupied until the actual
   thread settles. Detached exceptions are consumed without private logging;
   proven scheduling failures release admission without repeating that ID.
   `player_unresolved` refreshes owner identities with the existing interactive
   API deadline. Current owner/token/epoch/namespace/stop/expiry guards run
   after held work and at queue mutation. No guard calls queue methods.
6. Retry only current matching local cursor records via a narrow queue policy,
   preserving successful, missing, pending, unrelated and date-filtered work.
   A separate remote retry allowlist contains only the six reasons above;
   the existing local date-filter retry remains available. Preserve
   capture/engine opt-in. Lock state consistently with B1's
   `_STATE_SAVE_LOCK`, avoid lock inversions, save once with rollback on failure,
   request a watcher sweep and refresh recent-history/health facts. All new
   callbacks survive token replacement in GUI and headless modes.

The ready signal is advisory; current token authentication and post-ACK
presence are authoritative on the API. An agent must not treat ready alone
as permission after its connection epoch changes. Test stopped/owner-changed
fences during held refreshes, duplicate IDs and expiration before any mutation.

## Native identity, owner transactions and recovery

- The existing core parser has an optional ContextVar identity scope. It
  selects one exact non-observer saved toon **before** perspective-dependent
  deep outputs, even if a stale hint matches the opponent or both names are
  identical. Both-owned/no-match ambiguity stays unresolved. The unscoped
  browser/default name resolver and both parser signatures remain unchanged.
- Thread/live/fallback submissions capture parent owner/token/epoch tickets
  at admission; process jobs carry only bounded toons and a current hint,
  never the parent ticket or credentials. Both paths establish/reset the
  native scope. Native scope bypasses path recovery and flat cache promotion,
  preventing an old owner's held parse from writing a new owner's cache.
- Unknown identity is distinct from a current fetched profile with zero
  toons. Unknown work defers without terminal markers or leaked inflight /
  capture reservations. Successful contact starts at most one background
  profile refresh, bounded by the interactive deadline and a 30-second retry
  interval, then invalidates/wakes inventory so unchanged paths retry. Existing
  genuine skip markers remain. Known-empty profiles use only their fresh
  unique name hint; they cannot fall back to another owner's disk/path data.
- Explicit native Settings intent is stored privately in the existing
  `player_handle.json` cache with nonsecret owner/source metadata. It survives
  a same-owner restart and takes precedence over the cloud name hint; exact
  saved toons still take priority. Flat legacy caches have no proven owner
  or Settings provenance and require explicit re-entry. The form prefills
  only a proven current-owner override, sends KEEP for untouched text, and
  binds actual edits to a form-origin owner/epoch without a credential.
  Queued A edits cannot become B or a later A override. Explicit CLEAR
  retires the hint and requests guarded current-profile recovery; saved
  exact toons remain authoritative. Health reflects usable scoped identity.
- Cursor writers in watcher, queue and runner share `_STATE_SAVE_LOCK`.
  Queue repair/submission acquire queue lock then state lock, recheck current
  owner/marker/pending facts and save/rollback while serialized. Filesystem
  preflight occurs outside those locks and checkpoints each path. Queue
  admission binds the original owner atomically, after any held parse.
  State-only sections never call back into queue methods.
- Owner/token replacement retires old lifetimes and publishes under the
  state lock. Deferred automatic capture carries the original parent ticket
  through enqueue, cancellation, reparse and final guarded submit, including
  five-field stop cleanup. Capture remains opt-in; tests mock it entirely.
- Diagnostic candidates are owner/epoch scoped. Actual callback publication
  rechecks its original ticket, and report assembly rejects mismatched scope.
  Heartbeat captures its API before requesting an API-bound report, so held
  old reports cannot be sent under replacement credentials or update the
  replacement account's recovery hooks.

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
The API/web follow-up source review is clear. Its early hosted web types,
lint, tests, responsive checks and Vercel check passed. The early API run
reported 8,331 passed and 9 skipped, with one legacy-device-ID metadata
assertion failing; the root's compatibility fix then passed 20 focused local
API tests. It preserves legacy metadata while requiring canonical IDs for
retry support. These are **early phase results**, not final combined gates.

Final native source review and refuting verification are clear. The official
engine/sample refresh passed at source commit `2cf55f4b`: all 40 canonical
input paths, seven served assets and 49 byte pins were verified, and all four
sample games were deeply identical. Only the two generated metadata outputs
changed, committed as `37ef87aa`.

The first targeted native run at `37ef87aa` passed 786 tests and failed four
fixture assumptions: a synthetic expiry with a real clock, an intermediate
recovery observation and two budget fixtures without ready owner identity.
The reviewed test-only adapters preserve the expiry, ownership, recovery and
terminal-rejection assertions. These early results are not a final gate pass.

Required combined-head gates are targeted tests, API/web types and lint, both
mutation phases, full agent/web suites, all 83 route budgets and CI. Exact-head
results and immutable evidence are recorded in PR #866 and the roadmap delivery
reconciliation; this source checkpoint does not substitute for those checks.
No new dependency, flag,
provider/infrastructure configuration, production read, agent/StarCraft
launch, version bump, tag or release was performed.

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
checks. Native coverage is in `test_sync_retry`, `test_sync_retry_socket`,
`test_sync_retry_identity`, `test_sync_retry_recovery` and
`test_gui_sync_identity`, with queue/watcher/socket/heartbeat/runner/pairing/
parser/capture/player-handle neighbours. Existing watcher fakes now honor
guarded submission and declare a known synthetic profile; B1 identity facts
tests distinguish legacy return hints from current-owner parse authority.
No signed native release or installed-agent acceptance is certified here.

Preserve the 40 canonical input paths, seven served assets, four strict
samples, 49 raw pins and 83 route budgets. Only the official two-output
metadata refresh follows the completed native source review, with all four
games deep-equal. Do not publish, tag or rebuild agent 0.24.7/0.24.8.
