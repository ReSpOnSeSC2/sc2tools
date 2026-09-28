# ADR 0022: Parse replays in the browser with the agent's own Python

**Status**: Accepted
**Date**: 2026-09-28
**Owner**: web app (Instant Analysis)
**Related**: [Instant Analysis](../instant-analysis.md) (design and operations);
supersedes the server-side parser in
[`CLOUD_REPLAY_UPLOAD_ROADMAP.md`](../CLOUD_REPLAY_UPLOAD_ROADMAP.md)

## Context

Every game in SC2 Tools reaches the cloud through the Windows desktop
agent. It parses each `.SC2Replay` with `sc2reader` and the replay engine,
then posts the result to `POST /v1/games`. That leaves out everyone who
cannot or will not install a Windows program: Mac and Chromebook players,
work laptops, and visitors who want to see what the product does before
creating an account.

The cloud replay upload roadmap proposed the obvious fix: upload the replay
file, queue it, and parse it in a Python worker container. Three facts make
that a poor fit today:

- **Server capacity.** The API is a single Render Starter instance
  (`numInstances: 1`) with one replay-ingest admission slot
  (`REPLAY_INGEST_MAX_ACTIVE: 1`). A history import is thousands of replays
  at about half a second of CPython time each. A server parser would compete
  with agent uploads for that CPU, or need a queue, a worker service and
  storage for unparsed files: new infrastructure and new cost that grows
  with anonymous traffic.
- **Parity.** The analyzer's value depends on the exact payload the agent
  builds (`CloudGame.to_payload()`). Its `gameId` embeds the opponent's name
  and is the deduplication key. A second parser, or a different runtime
  configuration, would drift, and drift here means duplicate games and
  inconsistent charts.
- **Privacy.** Uploading every replay to parse it means holding files the
  user never asked us to keep.

A feasibility spike showed that Pyodide 314.0.7 (CPython 3.14.2 on
WebAssembly) runs the **unmodified** pipeline in a browser Web Worker. With
`state_dir=None` and `resolve_pulse=False`, the payload is byte-identical to
CPython's. A parse takes about 1 s cold and 0.6 s warm for a 7:50 game on a
desktop, after a download of roughly 15 MB.

## Decision

Parse replays **on the user's device**, in a dedicated Web Worker running
self-hosted Pyodide and the agent's own Python:

1. **One shared entry point.** `sc2tools_agent.instant_analysis.parse_replay_bytes`
   stages the bytes in Pyodide's in-memory filesystem and calls the
   unchanged `replay_pipeline.parse_replay_for_cloud_ex` with sandbox
   settings. `RuntimeOptions` makes the sandbox contract explicit: threads,
   file caches, network lookups and engine capture must all be `False`.
   The desktop agent keeps calling the pipeline directly.
2. **Parity is enforced, not hoped for.** `RUNTIME_ONLY_FIELDS` lists the
   only payload paths that may legitimately differ from an agent upload
   (SC2Pulse fields, legacy resumed aliases, engine-artifact playback). CI
   runs every fixture from every human perspective in both the source and
   the installed-agent data view. On those fixtures, only the two Pulse
   fields may differ from the desktop path. CI also checks that the Pyodide
   bundle's output equals the CPython goldens byte for byte.
3. **The installed agent's data view.** The bundle ships an empty
   `custom_builds.json` and no `map_bounds.json`, because that is what a
   frozen agent actually reads. Browser and agent uploads of the same replay
   therefore classify identically.
4. **Self-hosted, verified runtime.** A build step pins and
   hash-verifies the Python wheels, assembles a deterministic engine zip with
   precompiled bytecode, and publishes a manifest holding the SHA-256 of
   every asset under a content-addressed path. The worker verifies every
   asset before executing it: `blob:` imports, a fetch shim for the
   WebAssembly, and no lock-file or CDN fetch. Only the tiny pointer
   `/engine/current.json` is revalidated.
5. **The same ingest route.** Signed-in browsers upload the Python-produced
   JSON to `POST /v1/games` with a Clerk session. They send batches one at a
   time and honour `Retry-After`. The server stamps `ingestSource` from the
   auth source, keeps `engineVersion` for browser rows, and applies a per-user
   daily cap (`BROWSER_INGEST_DAILY_CAP`) that never applies to devices.
   `POST /v1/games/exists` lets the browser skip games already stored.
6. **Replay files stay on the device.** Anonymous `/try` uploads nothing and
   keeps parsed games in IndexedDB for 7 days, until the visitor saves them
   to an account. Signed-in imports and Folder Sync upload parsed data. A
   signed-in import also uploads the original files, using the agent's
   signed-URL protocol, when the server stores originals and its backup
   checkbox stays checked (the default, as the agent archives automatically).
7. **Staged rollout.** `NEXT_PUBLIC_INSTANT_IMPORT` goes `off` → `admins` →
   `all`. The engine build is optional while the flag is `off` and required
   otherwise.

## Consequences

### Positive

- Parsing adds no server CPU, and anonymous `/try` costs the API nothing.
  Adoption no longer scales the Render bill.
- Mac, Linux and Chromebook users, and anyone unwilling to install software,
  get the full analyzer from a real upload of their own games.
- One payload, one ingest path, one deduplication key. Every analyzer tab,
  per-game compute and opponent record works on browser-ingested games
  unchanged.
- Engine fixes reach browser users on the next web deploy. Cached assets
  invalidate themselves because every bundle path is content-addressed.
- Replay files stay on the device unless a signed-in import leaves its
  backup checkbox checked.

### Neutral

- Browser uploads arrive without SC2Pulse data (`opponent.pulseCharacterId`,
  `pulseLookupAttempted: false`). The existing crons fill them in:
  `pulseBackfillJob` links the opponent, and `opponentMmrEnrichmentJob`
  enriches recent ladder games within its window of at most 30 days
  ([ADR 0019](0019-forward-only-opponent-mmr-enrichment.md)). This is the
  same path the agent's history import already takes.
- Browser rows are identifiable by `ingestSource: "browser"` and
  `engineVersion`. If an engine bug ships, those cohorts can be found and
  re-parsed.
- The web build now needs Python ≥ 3.10 with `venv` wherever the feature
  is on. CI provides it, and the build explains what is missing.

### Negative

- A first visit downloads about 15 MB of runtime files, and parse speed and
  memory depend on the visitor's device. Mobile Safari's memory limits make
  iOS and iPadOS the weakest platforms, and Firefox and Safari still need
  manual verification.
- The browser cannot do what only an installed program can: live pre-game
  scouting and overlay data (the SC2 client API on `localhost:6119`),
  syncing without a tab open, accurate engine playback capture, and OBS
  scene switching. The product must say so honestly and keep offering the
  agent for those.
- Pyodide cannot be interrupted without cross-origin isolation, so a stuck
  parse is bounded by a 60 s timeout that terminates and replaces the worker.
- Upgrading Pyodide means re-running the byte-for-byte parity suite and
  checking the loader options the boot sequence relies on.

## Alternatives considered

### Server-side parser (upload → queue → Python worker)

Rejected for now. It needs new infrastructure (Redis/BullMQ, a worker
container, storage for unparsed files), puts CPU cost on a single small
instance, and requires uploading every replay just to look at it. The
roadmap's goals (web-only sign-up, mobile sharing, multi-device use) are met
without it. Community builds with a source replay remain open.

### Reimplement the parser in TypeScript

Rejected. `sc2reader`, the replay engine and the agent's payload logic are
large and battle-tested. A second implementation would drift from the agent,
and drift silently breaks deduplication.

### Load Pyodide and packages from a CDN, install with micropip

Rejected. It puts a third party in the execution path, makes integrity
depend on that third party, and pulls packages from it at runtime.
Self-hosting with a verified manifest keeps every executed byte under our
control and cacheable forever.

### A browser-specific Python module with its own payload code

Rejected. The whole point is parity. The sandbox entry point may stage files
and classify errors, but it must call the agent's unchanged pipeline, and a
test must prove it.

### Ship the repository's data files (seed custom build, map bounds table)

Rejected. The installed agent does not see them. Shipping them would make a
browser upload classify some games differently from the agent upload of the
same replay.

## Rollback

Set `NEXT_PUBLIC_INSTANT_IMPORT=off` and redeploy the web app. Every entry
point disappears, and the engine build becomes optional again. The API needs
no change: games already uploaded from browsers are ordinary game rows,
identifiable by `ingestSource: "browser"` and `engineVersion`, and remain
valid. To throttle rather than stop browser uploads, lower
`BROWSER_INGEST_DAILY_CAP` on the API. Deleting browser-ingested games would
need a separate, explicit data decision and is not part of rollback.

## References

- `apps/agent/sc2tools_agent/instant_analysis.py`, `instant_intake.py`
- `apps/agent/tests/test_instant_analysis.py`, `apps/agent/tests/instant_golden.py`
- `apps/web/scripts/build-browser-engine.mjs`, `apps/web/scripts/browser-engine/`
- `apps/web/lib/instant/` (worker, client, intake, identity, storage, upload)
- `apps/web/tests/engine/pyodide-parity.test.mjs`
- `apps/api/src/routes/gamesExists.js`, `apps/api/src/routes/gamesIngestPolicy.js`,
  `apps/api/src/services/browserIngestQuota.js`
- `apps/api/src/jobs/pulseBackfillJob.js`, `apps/api/src/jobs/opponentMmrEnrichmentJob.js`
- `.github/workflows/python-tests.yml` (`instant-parity`), `web-ci.yml`, `version-check.yml`
