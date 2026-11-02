# Agent sync health: checkpoint (roadmap item 76, B1)

The native agent now produces the heartbeat `sync` block consumed by the API
and web slices. This adds no version bump, tag, build, published installer or
new configuration switch. Agent 0.24.8 remains unpublished and owner-gated.

## Report and current state

- `Heartbeat` accepts an optional `sync_provider`. Both runner modes inject
  it. A provider failure, non-JSON value or oversized result is advisory: the
  normal heartbeat, recovery hooks and overlay-token processing continue.
- `sync_report.report_size` measures the default requests JSON encoding,
  including whitespace and escaped non-ASCII characters. Every sent block is
  strictly below 2048 bytes; compact UTF-8 encoding is smaller still. Names
  are removed first to fit, preserving current counts and error state.
- The provider copies `state.uploaded` under `_STATE_SAVE_LOCK` and derives
  skip, rejected and filtered counts from that private copy. It keeps only
  the API's closed skip reasons, including `unsupported_replay`. Both
  `filtered` and legacy `skipped:filtered` count as filtered, never as skips.
  Counts are clamped to the API's six-digit ceiling.
- Queue, archive, pause, folder and last-upload facts come from the single
  HealthMonitor. Missing configured folders are rechecked on report and
  subsequent folder changes. Only existing directories count as watched,
  including for a missing explicit environment root. Folder paths never
  enter the heartbeat.
- Upload failures are tracked independently of historical last-upload times
  and heartbeat failures. A successful upload or drained queue retires the
  failed work; recovered transport retires its own connection error. A later
  unrelated queue cannot revive an old failed upload. Terminal rejection
  callbacks can follow a queue-drained event; they are counted from markers,
  never allowed to seed a new queue's error. `lastErrorCode` is omitted when
  no replay is pending.
- `syncAccepted: false` logs one fixed warning per Heartbeat instance. It
  never logs the report, player names, toon handles or provider exception
  details, and never marks a successful heartbeat as failed. Old APIs without
  that field work normally.

## Unresolved names without changing the parser contract

`parse_replay_for_cloud_ex` keeps its signature and its `(game, reason)`
result. A scoped ContextVar observer records candidate `(name, toon handle)`
pairs only when the unresolved-player branch runs. Normal callers, including
Pyodide, observe the same parser outputs. Nested and concurrent scopes are
isolated, and exceptions always reset the observer.

Both watcher modes collect that side channel. A process worker keeps its
three-element result and carries candidate metadata only in an unresolved
skip's payload; the parent stores it after writing the current skip marker.
The thread path calls the same collector and callback. Callback failures
cannot interrupt the skip or expose its metadata in logs.

The runtime tracker deduplicates by replay path and toon handle, so retries
never count as extra sightings. Only current unresolved markers count. Names
are trimmed to at most 32 UTF-16 units and unsafe names/handles are dropped.
The report takes at most ten handles seen in at least three distinct current
replay paths, ordered by count and handle.

Candidate metadata is a bounded diagnostic sample of the newest 2048 parsed
unresolved paths. Current marker counts remain exact independently of that
sample. Retired paths are pruned; a generation ticket prevents a concurrent
new capture from being discarded against an older marker copy. Names are
runtime-only: after restarting, existing skip counts still report, while
candidate names repopulate when those files are parsed again. No new name
store or state schema is introduced.

## Health hooks

- Device socket connect, disconnect and stop update the monitor, including
  sockets rebuilt after token replacement. Overlay-session connections do
  not replace device-socket facts.
- Every valid local `/ui` or `/game` poll refreshes live contact, even while
  no lifecycle phase changes. Feature enablement is known at boot.
- OBS connection, request disconnect, authentication failure, settings
  reconnect and shutdown update health through an isolated callback. The
  existing post-connect repair callback remains in place.
- Identity resolution reports cloud, cache, replay autodetection, local
  environment configuration or unknown; an explicit Settings player name
  reports Settings as its source. A cache repair after the first replay
  retires the unknown-name row on upload success, periodic status refresh
  or the next heartbeat without changing the parser contract.
- The headless tray's Add replay folder now updates the same shared health
  facts as Settings and the GUI.

## Verification status

Source syntax parsing and `git diff --check` passed during implementation.
No runtime test, full suite, native launch, build or mutation result is claimed
here yet. The root is serializing checks; independent review and refuting
verification precede delivery.

`tests/test_sync_report.py` covers closed/current/legacy markers, deduped
current paths, top-ten and multibyte/default-encoder size limits, unsafe
names, bounded metadata/pruning races, provider locking, recovery and
drain semantics, concurrent capture/reporting, nested/thread-local scopes,
both watcher modes, token replacement, continued local contact, OBS states,
identity sources, headless folders and advisory callback failures.

Related checks include the HealthMonitor, runner settings/folders/recovery,
watcher worker paths, socket and live-client/OBS suites, Instant Analysis
parity and the full agent suite. The 40-input engine list, seven served
assets, four strict samples and 49 raw pins are unchanged. Signed release
and installed-agent acceptance remain outstanding owner-gated requirements.
