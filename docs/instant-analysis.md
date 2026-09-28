# Instant Analysis (in-browser replay parsing)

Instant Analysis parses StarCraft II replays **on the visitor's own device**,
inside a Web Worker running the desktop agent's Python pipeline under
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly). Anyone can
drop replays on `/try` and get a real report without an account or an
install. A signed-in user can import their history, or keep a replay folder
in sync, without installing the Windows agent.

How it works and how to run it. Decision record: [ADR 0022](adr/0022-instant-analysis-browser-parsing.md);
screenshots: [`screenshots/instant-analysis/`](screenshots/instant-analysis/).

- **Python (shared with the agent):**
  - `apps/agent/sc2tools_agent/instant_analysis.py`: sandbox entry point
    (`parse_replay_bytes`, `list_replay_players`, `RuntimeOptions`,
    `RUNTIME_ONLY_FIELDS`)
  - `apps/agent/sc2tools_agent/instant_intake.py`: zip expansion, digests,
    temp-file staging
  - `apps/replay-engine/core/replay_errors.py`: load-failure classification
- **Engine build:** `apps/web/scripts/build-browser-engine.mjs` and
  `apps/web/scripts/browser-engine/*`
- **Worker and client:** `apps/web/lib/instant/engine*.ts`, `integrity.ts`,
  `protocol.ts`, `types.ts`
- **Client libraries:** `apps/web/lib/instant/` (`useInstantSession` and
  `session*`, `fileIntake`, `meDetection`, `toonPath`, `localStore`/`idb`,
  `ledger`, `folderSync`, `folderSyncRunner`, `importRunner`, `batches`,
  `uploader`, `httpRetry`, `profileHandles`, `replayBackup`, `report`,
  `authRedirect`, `flag`, `useInstantImport`, `analytics`, `errorCopy`)
- **UI:** `apps/web/app/try/`, `apps/web/components/instant/*`
- **API:** `POST /v1/games` (browser provenance and daily cap),
  `POST /v1/games/exists`; see "Browser ingest" in
  [`apps/api/README.md`](../apps/api/README.md#browser-ingest)

## Goal

- **Zero-install first value** in a desktop browser, including on a Mac, a
  Chromebook or a work laptop where the agent cannot run.
- **The agent's data, exactly.** A browser upload of a replay produces the
  same game row as the agent's upload of the same bytes and perspective, so
  every analyzer tab works and the two never duplicate each other.
- **No new server load.** Parsing costs the API nothing; uploads reuse the
  existing ingest route and its single admission slot.
- **Replays stay on the device.** Only parsed game data is uploaded, when
  the user saves or imports, plus the original files when a signed-in
  import keeps its backup checkbox checked.

## User flows

### `/try` (anonymous)

1. The visitor drops `.SC2Replay` files or a `.zip` onto the page, or picks
   files or a folder. `/try` keeps the newest 25 replays per run
   (`MAX_TRY_FILES`; zip entries carry their own stored times) and defaults
   to "All time", because the 25-file cap already bounds the work and a
   90-day window would hide the games of someone who has not played lately.
   The signed-in import defaults to "Last 90 days". The file's modification
   time is checked first, with the agent's 7-day slack. The replay's own
   date is checked again in the header scan and, finally, after parsing.
2. The engine starts warming up on the visitor's first intent to add
   replays (pressing "Choose replays", dragging files over the drop zone,
   focusing the intake: `session.prewarm()`), never on page load. The first
   run downloads the analyzer once; later visits use the HTTP cache.
3. A cheap header scan (`list_replay_players`) lists the players in each
   replay. Games against the A.I. and, on `/try`, anything that is not a
   1v1 are dropped here (`ai_game`, `not_1v1`), before anyone is asked
   which player they are. [Which player is me](#which-player-is-me) then
   picks the visitor, asking for a one-tap confirmation when it is guessing.
4. Each remaining replay is parsed in the worker. `/try` also skips
   "resume from replay" sessions (`resumed_replay`).
5. The report shows only cards the payloads support: record, record by
   matchup, openers, most-faced opponent, macro score and top leaks, and "why
   you lost" for the latest loss (`lib/instant/report.ts`). A card with no
   data is hidden.
6. **Nothing is uploaded unless the visitor saves.** The parsed games (at
   most 100) are kept in IndexedDB for 7 days, so the visitor can come back
   to the report.
   The save card offers sign-up or sign-in, which returns to
   `/try?resume=1`. That page uploads the stored payloads through the
   signed-in upload path below, without parsing again. A visitor who is
   already signed in gets a save button instead. Each game is tagged with
   the engine version that parsed it, not the one deployed at upload time.
   After a successful save the local copies are deleted and the visitor
   lands on `/app`.

### Signed-in import

Settings → Import, the `/welcome` onboarding import step, and the analyzer's
empty states offer "Import in your browser" next to "Install the agent":

1. Pick replays, a zip, or the StarCraft II `Accounts` folder. Picking the
   folder is best, because each replay's path then contains the toon folder
   that identifies the player exactly.
2. The same scan, identify and parse steps as `/try` run. The 1v1-only rule
   is a session option (`onlyOneVsOne`) that `/try` turns on.
3. `POST /v1/games/exists` drops games the account already has.
4. The rest upload in batches (see [Uploads](#uploads)).
5. Toon handles the user confirmed are saved to their profile, so the next
   import does not ask again.
6. If the server stores original replays, the panel shows an "Also back up
   original replay files" checkbox, **checked by default**. When it stays
   checked, the original files of the accepted games are uploaded last, one
   at a time (see [Original replay backup](#original-replay-backup)).

### Folder Sync (Chromium desktop)

With the File System Access API (`showDirectoryPicker`, Chromium browsers),
the user picks their `Accounts` folder once. The page stores a **read-only**
directory handle in IndexedDB, **bound to the signed-in account**. There is
no timer: `FolderSyncAutoRunner` (mounted by `/app` only) checks when the
dashboard loads and whenever its tab regains focus or becomes visible, and
re-scans at most every 10 minutes (`MIN_AUTO_SCAN_INTERVAL_MS`). A re-scan
walks only `<account>/<toon>/Replays/Multiplayer/*.SC2Replay`, at most 6
levels deep, and yields to the UI every 32 entries or 16 ms. The engine
starts only when there are new or changed replays.

A per-file ledger (path, size, modification time, status) means a re-scan
only parses files that are new, changed, or failed for a transient reason
(timeouts and crashes are retried at most 3 times in all,
`MAX_RETRYABLE_ATTEMPTS`). A replay whose player could not be identified
is re-checked only once the profile learns one of its toons. After the
daily upload cap, auto-sync pauses until the server's reset time
(persisted per account). When the browser asks to grant read access again,
the page shows a one-click "Resume sync" (browsers only re-grant inside a
click). "Stop syncing" forgets the folder and its ledger. Folder Sync
uploads parsed data only, never original files. When the browser refuses
storage (private window), a pass still runs with an empty ledger.

**Account binding.** A folder remembered for another account (a shared
browser) never syncs and shows no "Resume" banner; the card offers "Use this
folder for this account", which first forgets the other account's ledger
and scan time. The runner itself refuses such a pass (`notOwner`).

Other browsers get a one-shot `<input webkitdirectory>` folder import. It
keeps the same account-bound ledger, so a repeat import skips finished
files, and "Forget import history" on the card clears it.

### Entry points

Every entry point is gated by the rollout flag (see [Rollout](#rollout)).

- **Landing (only with `all`):** a hero button and a link under the replay
  demo, both to `/try`.
- **`/welcome`:** the onboarding import step offers browser import alongside
  the agent download.
- **Analyzer empty states and Today:** an account with no games that has
  not started the agent path sees both options side by side; the agent
  checklist keeps an "or import in your browser" link until games arrive.
  Without an agent, Today and Settings → Overlay show a soft "Install the
  agent for live features" note → `/download`.
- **Settings → Import:** the browser importer and the Folder Sync card.

## Architecture

```
 MAIN THREAD (page)                              DEDICATED WEB WORKER (engineWorker.ts)
 ──────────────────                              ──────────────────────────────────────
 ReplayIntake / Folder Sync                      engineWorkerHost.ts
   │  File objects (never read in bulk)            one request at a time, never logs
   ▼                                               │
 useInstantSession (date window, meDetection)      ▼
   │                                             enginePyGlue.ts  (_sc2t_players / _sc2t_parse /
   ▼                                               │               _sc2t_unzip, gc.collect() after each)
 EngineClient (engineClient.ts)                    │  ── Python, inside Pyodide 314.0.7 (CPython 3.14) ──
   queue, 60 s per file, recycle every 150         ▼
   │                                             sc2tools_agent.instant_analysis
   │  postMessage({bytes}, [bytes])  ────────►     parse_replay_bytes / list_replay_players /
   │  (ArrayBuffer transferred, not copied)        expand_replay_zip / replay_digests
   │                                               │  stage bytes in MEMFS under a fresh temp dir
   │                                               ▼
   │                                             replay_pipeline.parse_replay_for_cloud_ex   (UNCHANGED)
   │                                               state_dir=None, resolve_pulse=False
   │                                               │
   │                                               ▼
   │  ◄────────  {envelope: {ok, gameId, json,   CloudGame.to_payload() → compact_json_bytes()
   │              date, myToonHandle, ...},
   │              digests?}
   ▼
 /try:      IndexedDB (7 days, ≤ 100) ─► report cards  (nothing leaves the device until the visitor saves)
 signed in: POST /v1/games/exists ─► POST /v1/games (≤ 50 games, ≤ 4.5 MiB, one batch at a time)
            ─► optional backup: POST …/replay-upload ─► PUT signed R2 URL ─► POST …/complete
```

Each worker boots once. A recycled or replaced worker boots again, from the
HTTP cache:

```
 GET /engine/current.json            (Cache-Control: no-cache; tiny pointer)
  └► GET /engine/1.6.3/<bundleId>/manifest.json            (immutable)
      └► GET 5 assets in parallel, SHA-256 each against the manifest:
           /pyodide/314.0.7/pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip
           /engine/1.6.3/<bundleId>/engine.zip
          └► import pyodide.mjs + pyodide.asm.mjs from verified blob: URLs
             loadPyodide({createPyodideModule, stdLibURL: blob:, lockFileContents})
             (wasm served to Pyodide by a fetch shim that returns the verified bytes)
              └► unpack engine.zip at "/" → prepend "/sc2tools/apps/agent" to sys.path
                 → import sc2tools_agent.instant_analysis → "ready"
```

The Python never sees the network. sc2reader's `load_map` option stays at its
default (off), so it never downloads map files, and the SC2Pulse resolver is
neither called nor shipped.

## Why the browser, not a server parser

Instant Analysis replaces the upload → Redis/BullMQ → Python worker plan in
[`CLOUD_REPLAY_UPLOAD_ROADMAP.md`](CLOUD_REPLAY_UPLOAD_ROADMAP.md)
([ADR 0022](adr/0022-instant-analysis-browser-parsing.md) has the full
reasoning). The API is one Render Starter instance (`numInstances: 1`) with
one ingest slot (`REPLAY_INGEST_MAX_ACTIVE: 1`), so parsing on the visitor's
CPU costs the server nothing, and the browser posts the agent's exact payload
to the same `POST /v1/games`. Parity is a byte comparison in CI rather than a
reimplementation. The costs: a one-time download of about 7.6 MB over the
wire (14.6 MB decoded; see [Budgets](#budgets)), device-dependent speed and
memory, and no SC2Pulse lookups while parsing (the server fills those in
later).

## One Python entry point

`sc2tools_agent.instant_analysis` is the only module the worker imports. It
re-implements nothing. `parse_replay_bytes`:

1. Rejects anything that is not an MPQ archive (`not_a_replay`) before
   touching sc2reader.
2. Stages the bytes as a real file under a fresh temp dir in Pyodide's
   in-memory filesystem (map playback re-opens the replay by path), named
   `replay.SC2Replay` and prefixed by the toon folder when the original path
   had one (`1-S2-1-267727/replay.SC2Replay`). The user's file and folder
   names never reach the sandbox filesystem, logs or exception text.
3. Masks `SC2TOOLS_OBSERVATION_DIR`, `SC2TOOLS_PLAYER_HANDLE` and
   `SC2TOOLS_PLAYER_CONFIG` for the call, so nothing outside the bytes can
   influence the payload.
4. Calls the **unchanged** `replay_pipeline.parse_replay_for_cloud_ex(path,
   player_handle=…, state_dir=None, resolve_pulse=False)`. The desktop agent
   keeps calling that function directly and never goes through this module.
5. Returns `{"ok": True, "gameId", "json", "payload", "date",
   "myToonHandle", "matchFormat", "isResumedFromReplay"}`. `json` is
   `compact_json_bytes(payload)` as ASCII: the exact upload bytes, never
   re-serialised in JavaScript. On failure it returns `{"ok": False,
   "reason", "errorKind", "detail"}`, where `detail` is a class name plus
   fixed text and never a player name or path.

### `RuntimeOptions`

```python
@dataclass(frozen=True)
class RuntimeOptions:
    player_handle: Optional[str] = None  # display-name substring (agent semantics)
    player_toon: Optional[str] = None    # exact toon handle; preferred
    threads: bool = False                # must stay False
    file_caches: bool = False            # must stay False (no state dir, handle cache, env lookups)
    network_lookups: bool = False        # must stay False (no SC2Pulse)
    engine_capture: bool = False         # must stay False (no local engine observation artifacts)
```

`parse_replay_bytes` raises `ValueError` if any capability flag is True. For
`player_toon`, see [Which player is me](#which-player-is-me).

### Parity allowlist: `RUNTIME_ONLY_FIELDS`

These are the only dotted payload paths that may legitimately differ between
a desktop upload and a browser upload of the same bytes and perspective:

| Path | Why it can differ |
| --- | --- |
| `opponent.pulseLookupAttempted` | The desktop live lane asks SC2Pulse (`True`). The sandbox never does, so it is always `False`, as on the agent's historical backfill lane. |
| `opponent.pulseCharacterId` | SC2Pulse network result on the desktop. Absent in the browser. |
| `resumedReplayGameIds` | Added by the desktop upload queue from its local path state. |
| `mapPlayback` | A local engine observation artifact upgrades playback on the desktop, or replaces it with R2 segments. |
| `spatial.map_bounds`, `spatial.battles`, `spatial.deaths` | Re-derived from engine-merged playback when that artifact exists. |

The parity test is stricter: on the committed fixtures **only** the two
Pulse fields may differ (the desktop call uses `resolve_pulse=True` against a
stubbed resolver), and with the sandbox flags the desktop function produces
JSON byte-identical to the browser's.

### `gameId` determinism

`gameId` is `"<replay end time ISO>|<opponent name>|<map>|<length seconds>"`,
for example `2026-05-08T19:08:12|Squirtuoz|Tourmaline LE|470`. It depends on
the bytes and **on the perspective** (the opponent's name is in it). It never
depends on the file name, the folder or the modification time. The parity
suite checks renamed, nested, re-dated and toon-folder variants of every
fixture and requires identical JSON. The only non-byte input is the
perspective, which is why [Which player is me](#which-player-is-me) matters.

### Data view: the installed agent, not the source tree

A frozen (PyInstaller) agent reads `<exe>/data/custom_builds.json`, which
it creates **empty**, and has **no** `map_bounds.json` (bounds come from the
replay's MapInfo). The browser bundle mirrors that installed agent (an empty
`custom_builds.json`, no `map_bounds.json`), so both uploads get the same
`myBuild`, `opponent.strategy` and bounds. The parity suite runs every case
in both the `installed` and the `source` data views; `gameId`s must match.

## What differs from an agent upload

| Field or behaviour | Agent upload | Browser upload | How it converges |
| --- | --- | --- | --- |
| `opponent.pulseCharacterId` | Resolved from SC2Pulse at parse time on the live lane; absent on the history-backfill lane | Absent | `jobs/pulseBackfillJob.js` (every 15 min) resolves the opponent record's toon handle to a Pulse character id and re-stamps `opponent.pulseCharacterId` (and `opponent.region`) on that user's games with that opponent. |
| `opponent.pulseLookupAttempted` | `true` (live) / `false` (history backfill) | Always `false` | Because of `false`, ingest skips the immediate SC2Pulse MMR fetch for the opponent record and leaves it to the crons (the agent's history-import behaviour). |
| `opponent.mmr`, `opponent.leagueId` when the replay lacks them | Same replay-sourced values | Same replay-sourced values | `jobs/opponentMmrEnrichmentJob.js` fills them from SC2Pulse only for ladder games whose replay date **and** ingest time fall inside its recency window (at most 30 days), and only after `opponent.pulseCharacterId` is present. Older games stay empty on purpose ([ADR 0019](adr/0019-forward-only-opponent-mmr-enrichment.md)). |
| `resumedReplayGameIds` | Legacy aliases from the agent's local state | Never sent | Not needed. The browser has no legacy ids to alias. |
| `mapPlayback` | Tracker-based inline playback; with accurate capture on, engine-fidelity playback uploaded as verified R2 segments | Tracker-based inline playback only | "Generate accurate playback" still needs the agent and StarCraft II. The server never lets a tracker upload overwrite a stored complete engine recording (`services/playbackPreservation.js`). |
| `spatial.map_bounds` / `battles` / `deaths` | Derived from engine playback when an artifact exists | Derived from tracker playback | Same as above. |
| `ingestSource` | Stamped `"agent"` by the server (device token) | Stamped `"browser"` by the server (Clerk session) | Server-derived from the auth source; whatever the payload claims is overwritten. |
| `engineVersion` | Dropped | Kept (e.g. `1.6.3`) | Lets browser-ingest cohorts be found and re-parsed if an engine bug is found. |
| Original `.SC2Replay` | Uploaded by the archive lane when the server stores originals | Signed-in import with its backup checkbox checked (the default when the server stores originals) | See [Original replay backup](#original-replay-backup). |
| Daily volume | Unlimited | `BROWSER_INGEST_DAILY_CAP` games per user per UTC day (default 5000) | Over-cap batches get a non-retryable `429`; the rest stay pending until the UTC day resets. |

Everything else in the payload must match byte for byte (`gameId`, `date`,
`result`, races, map, build logs, `myBuild`, MMR fields, toon handles, …).

## Engine asset pipeline

`npm run engine:build` (`scripts/build-browser-engine.mjs --require`) and the
`prebuild` hook generate `apps/web/public/pyodide/` and `public/engine/`
(gitignored).

1. **Version pins** (`browser-engine/versions.mjs`, always fatal on drift):
   `INSTANT_ENGINE_VERSION` must equal `apps/replay-engine/VERSION`, and
   `PYODIDE_VERSION` the exact `pyodide` pin and installed package.
2. **Wheels** (`browser-engine/wheels.mjs`). A private venv under
   `node_modules/.cache/sc2tools-browser-engine/venv` gets hash-pinned `pip`
   and `setuptools`, then `pip wheel --no-deps --require-hashes
   --no-build-isolation` builds `sc2reader==1.8.0` and `mpyq==0.2.5` from
   `requirements.txt` (every file pinned by SHA-256; mpyq's sdist builds with
   `SOURCE_DATE_EPOCH=315532800` into a reproducible wheel). Wheels are
   cached per requirements hash; any other wheel set is refused.
3. **Bundle** (`browser-engine/pyodideBundle.mjs` + `bundle_tools.py`, run
   **inside Pyodide in Node**):
   - Unpack the wheels into site-packages.
   - Copy the allowlisted repo files (`browser-engine/files.mjs`) to
     `/sc2tools/...`: the traced import closure of `parse_replay_bytes`.
     Tests, detectors, map images, `pulse_resolver`, `playback_artifacts`
     and `map_bounds.json` are excluded.
   - Write the empty `custom_builds.json`.
   - Compile **unchecked-hash** `.pyc` files. Zip extraction does not restore
     mtimes, so timestamp-based `.pyc` would always look stale. Sources stay
     in the zip because the pipeline's loaders check that `<module>.py`
     exists.
   - Write a deterministic zip: sorted entries, 1980-01-01 timestamps,
     `rw-r--r--`, deflate level 9, `PYTHONHASHSEED=0`. Compiling inside
     Pyodide means the bytecode matches the exact CPython the browser runs.
4. **Smoke parse.** A fresh interpreter unpacks that exact zip, activates it
   the way the worker does, and parses a fixture replay. The build fails
   unless the parse succeeds.
5. **Publish** (`browser-engine/publish.mjs`):
   - Copy the four Pyodide files to `public/pyodide/<pyodideVersion>/`.
   - Write `engine.zip` and `manifest.json` to
     `public/engine/<engineVersion>/<bundleId>/`. The manifest lists the
     SHA-256 and size of every asset, the Pyodide lock `info`, the Python
     entry point, the agent version and the wheel digests.
   - Write `public/engine/current.json` **last** (the commit point).
   - Prune older bundles of the same engine version.

   `bundleId` is the first 16 hex characters of the SHA-256 of the manifest
   (with the id fields blank). Any change to the zip, the Pyodide files, the
   pins or the manifest itself produces a new path.
6. **Cache headers** (`next.config.mjs`): `/pyodide/**` and
   `/engine/<version>/<bundle>/**` are served with
   `public, max-age=31536000, immutable`. `/engine/current.json` is served
   with `no-cache`, so a deploy switches bundles on the next boot.

**Required or optional.** The build is **required**, and fails on any
error, with `--require` (`npm run engine:build`), with
`INSTANT_ENGINE_REQUIRED=1`, or when `NEXT_PUBLIC_INSTANT_IMPORT` is `admins`
or `all`. Otherwise it looks for Python ≥ 3.10 with `venv` and `ensurepip`
(`$PYTHON`, then `python3`, then `python`). If it finds none, or the build
fails, it prints a warning and exits 0 without writing a new pointer, and
Instant Analysis is unavailable in that build. Version drift is always
fatal.

The current build (engine 1.6.3, Pyodide 314.0.7, CPython 3.14.2) is about
14.6 MB on disk: `pyodide.asm.wasm` 9.6 MB, `python_stdlib.zip` 2.5 MB,
`pyodide.asm.mjs` 1.25 MB, `engine.zip` about 1.2 MB and `pyodide.mjs`
18 kB. Served gzipped, that is about 7.6 MB over the wire (the two zips are
already compressed).

## Integrity model

Every byte the worker executes is verified against the manifest before use
(`integrity.ts`, `engineBoot.ts`):

- The pointer and manifest are validated structurally. Asset paths must be
  same-origin absolute paths, digests must be 64-hex, and every role must
  appear exactly once. A pointer or manifest whose `protocol`,
  `engineVersion` or `pyodideVersion` differs from this page's pins is
  refused with `engine_unavailable` ("engine updated; reload the page"), so
  the page JS and the engine always come from the same release.
- All five assets are fetched as bytes, and their SHA-256 (SubtleCrypto) must
  equal the manifest's. A mismatch is `integrity_failed`, and nothing is
  executed.
- `pyodide.mjs` and `pyodide.asm.mjs` are imported from **blob: URLs made
  from the verified bytes** (`loadPyodide({createPyodideModule})`). The
  stdlib is passed as a verified `blob:` `stdLibURL`.
- The WebAssembly is served to Pyodide by a **worker-scoped fetch shim**:
  the wasm URL gets the verified bytes, `blob:` URLs pass through, and
  **every other request is refused** while Pyodide starts.
- The lock file is **never fetched** (`lockFileContents` is the manifest's
  `lockInfo` with no packages), so nothing is loaded from a CDN.
- **No network while parsing.** A boot revalidates the small
  `/engine/current.json` (so it fails offline); parsing needs no network:
  SC2Pulse lookups are off (the resolver is not shipped) and sc2reader never
  downloads maps.

The model trusts the manifest (same origin as the page's JavaScript): it
catches corrupted or tampered static files and caches, and keeps every
third-party host out of the execution path.

## Content Security Policy

The site sets no CSP today. If one is added, it must allow the engine, and
the worker chunk under `/_next/static/` needs these directives too (workers
enforce the policy of **their own script response**):

| Directive | Needed value | Why |
| --- | --- | --- |
| `script-src` | `'self' blob: 'wasm-unsafe-eval'` | `pyodide.mjs` and `pyodide.asm.mjs` are imported from verified `blob:` URLs, and the runtime compiles WebAssembly. `'unsafe-eval'` is **not** needed. |
| `worker-src` | `'self'` | The worker script is a same-origin chunk. |
| `connect-src` | `'self' blob:` | The pointer, manifest and assets are same-origin, and Pyodide `fetch()`es the verified stdlib from a `blob:` URL, which `'self'` does not match. |

Checked in headless Chromium (Next's classic worker, `default-src 'none'`,
the header on every response): boot and parse succeed with exactly these
values; without `blob:` the boot fails with `engine_boot_failed`, and
without `'wasm-unsafe-eval'` it hangs until the 120 s timeout. Firefox and
Safari were not checked.

The rest of the flow also needs `connect-src` entries that are not about the
engine: the API origin (`NEXT_PUBLIC_API_BASE`), Clerk, and the R2 bucket
origin for backup PUTs.

## Worker and client behaviour

`createEngineClient()` (`engineClient.ts`) is the only entry point for UI
code:

- **Lazy.** The worker is created on the first call (`boot`, `listPlayers`,
  `parseFiles`, `expandZip`). Concurrent boots share one promise. Pyodide
  loads only after a user action (first intent to add replays), or when
  Folder Sync finds new replays.
- **Strictly sequential.** Calls queue behind each other, and files go to the
  worker one at a time. Each file is read with `blob.arrayBuffer()` just
  before sending and **transferred**, not copied, so the main thread never
  holds more than one replay.
- **Timeouts.** 60 s per file (`DEFAULT_PER_FILE_TIMEOUT_MS`) and 120 s to
  download and boot (`DEFAULT_BOOT_TIMEOUT_MS`). Pyodide cannot be
  interrupted without `SharedArrayBuffer` (which needs COOP/COEP; the site is
  not cross-origin isolated). A stuck parse is therefore stopped by
  terminating the worker and starting a new one for the next file.
- **Bounded heap.** Every scan and parse ends with `gc.collect()` (a zip
  expansion collects once its entries have been handed over), which keeps
  the WebAssembly heap flat. The worker is also recycled after every 150
  parses (`DEFAULT_RECYCLE_EVERY`).
- **Resilient.** A file that times out, crashes the worker or runs out of
  memory fails alone. The worker is replaced and the batch continues. If a
  re-boot fails mid-batch, the remaining files fail with that kind and
  finished results are kept.
- **Cancellable.** `cancel()` or an aborted `AbortSignal` terminates the
  worker, and in-flight and queued files resolve as `cancelled`.
- **Size guards.** Before a file reaches the engine client, the session intake
  (`sessionIntake.ts`) and the Folder Sync runner fail a replay over 32 MiB
  (`MAX_REPLAY_BYTES`), and the intake a `.zip` over 256 MiB
  (`MAX_ZIP_ARCHIVE_BYTES`: an archive sits in memory twice before Python's
  guards run), as `too_large` without reading it. Python's `zipfile`
  expands archives inside the worker (`expand_replay_zip`): at most 20,000
  entries of any kind, 1,000 replay entries, 20 MiB per entry and 128 MiB
  in total. Each returned `*.SC2Replay` carries its stored modification
  time (read as UTC), so the newest-first cap applies inside zips too.
- **Next.js detail.** Next emits a *classic* worker; Pyodide's ESM refuses
  to start when it sees `importScripts`, so `withImportScriptsHidden` hides
  it during boot.

### Error kinds

`ErrorKind` (`lib/instant/types.ts`) is a wire contract with the Python
constants. A test fails if the two lists drift apart. Friendly copy lives in
`lib/instant/errorCopy.ts`.

| Kind | From | Meaning | Worker reused? |
| --- | --- | --- | --- |
| `not_a_replay` | Python | The bytes are not an MPQ archive. | yes |
| `corrupt_file` | Python / zip | The archive is damaged or truncated, the player list is unreadable, or the zip is invalid or encrypted. | yes |
| `unsupported_version` | Python | sc2reader cannot decode this patch (usually a replay newer than the engine). | yes |
| `parse_failed` | Python | Load failed for another reason. | yes |
| `analysis_failed` | Python | The replay loads but the analysis raised, or staging failed. | yes |
| `ai_game` | header scan / Python | Game against the A.I. (never uploaded, same as the agent). | yes |
| `player_unresolved` | Python / client | Could not tell which player is the user, or the chosen toon is not in this replay. | yes |
| `player_ambiguous` | Python | The requested toon resolved to a different player whose name contains the same text. | yes |
| `no_result` | Python | The user's player has no Win/Loss/Tie. | yes |
| `playback_budget_exceeded` | Python | The game's data would exceed the 5 MiB upload body cap even with reduced playback (the agent has the same limit). | yes |
| `engine_unavailable` | Python / client | The engine import failed, the pointer or manifest is from another release, or an asset could not be downloaded. | no (boot) |
| `integrity_failed` | client | An asset's SHA-256 did not match the manifest. | no (boot) |
| `engine_boot_failed` | client | The worker could not be created, or Pyodide failed to start or did not start within 120 s. | no (boot) |
| `timeout` | client | No answer within 60 s. | no, replaced |
| `out_of_memory` | client | The WebAssembly heap or the JS engine ran out of memory. | no, replaced |
| `worker_crashed` | client | The worker died or Pyodide itself failed. | no, replaced |
| `too_large` | client / zip | The replay (over 32 MiB), the archive (over 256 MiB) or the zip's contents exceed the intake guards. | yes |
| `not_1v1` | client policy | `/try` analyses 1v1 games only (decided from the header scan). | n/a |
| `resumed_replay` | client policy | `/try` skips "resume from replay" sessions (decided after parsing). | n/a |
| `outside_date_range` | client policy | The file's modification time, the header scan's date or the parsed date is outside the chosen window. | n/a |
| `cancelled` | client | The user cancelled. | n/a |

## Which player is me

`gameId` embeds the **opponent's** name, so picking the wrong "me" would
silently create duplicate games. `detectMe` (`meDetection.ts`) follows the
agent first and falls back to softer evidence only with confirmation:

1. **Path (the agent's rule).** A relative path segment matching
   `^\d+-S2-\d+-\d+$` (for example `1-S2-1-267727`), scanned from root to
   leaf, names the player exactly. `toonPath.ts` reproduces
   `replay_pipeline._toon_handle_from_path` byte for byte, including Python's
   Unicode `\d` and the `$`-before-newline quirk. Folder imports keep the
   picked folder's own name in the path, so the toon segment survives.
2. **Profile toons.** A player whose toon is one of the signed-in user's
   saved toon handles (`pulseIds` / `detectedPulseIds` entries that look like
   toons).
3. **Majority.** Across the remaining loose files, a toon present in at least
   **60%** of them (with at least 2 files) is proposed, and the user confirms
   it with **one tap**.
4. **Ambiguous.** A single loose file, or a tie, shows a chooser.

Each file is then parsed with `player_toon` set, which Python resolves to
that player's in-replay name for the unchanged pipeline. A file where the
chosen toon did not play fails `player_unresolved` without calling the
engine. After the parse, a payload `myToonHandle` other than the requested
toon fails `player_ambiguous`: the **guard** against the pipeline's
display-name substring match picking "BobBy" for "Bob".

After a signed-in import, confirmed toons are appended to the profile's
`pulseIds` (maximum 20; `profileHandles.ts`) with GET → merge → PUT, since
`PUT /v1/me/profile` replaces the profile; nothing new, no PUT.

## Uploads

`uploadGames` (`uploader.ts`) is a polite guest on the API's single ingest
slot:

1. **Skip what the account already has.** `POST /v1/games/exists` takes up to
   500 ids per call and drops games already stored, so no upload budget is
   spent on them.
2. **Tag and batch.** `"ingestSource":"browser","engineVersion":"1.6.3"` is
   spliced after the opening brace of each game's Python JSON (a stored
   `/try` game keeps the version that parsed it). The JSON is
   never re-serialised, which would change bytes. Bodies are packed into
   batches of **at most 50 games and 4.5 MiB** (the server caps bodies at
   5 MiB and must receive them within 45 s over a home uplink). A game
   larger than 5 MiB on its own is never sent.
3. **One batch at a time**, each with a **fresh Clerk token**. A `401` gets
   one forced token refresh. A second `401`, or a `403`, stops the run.
4. **Retry.** `503 replay_ingest_busy`, `408`, other 5xx, a `429` other than
   the daily cap, and network errors retry the same batch after
   `max(Retry-After, full-jitter exponential backoff)`, capped at **60 s**
   (base 1 s, at most 8 attempts per batch). The API exposes `Retry-After`
   via CORS; unreadable, it counts as 5 s. A `413` splits the batch in half.
5. **Daily cap.** `429 browser_ingest_daily_cap` refuses a batch that would
   cross `BROWSER_INGEST_DAILY_CAP` (default 5000 games per user per UTC
   day) and says how many still fit (`remaining`) and when the cap resets
   (`resetAt`). That many are sent once as a smaller batch, then the run
   stops; the rest stay pending and the UI says when uploads resume (local
   time). Progress counts games already in the account as done.
6. **Per-game rejections** marked `retryable`, and ids missing from the
   response, are requeued once into a later batch.

The server derives `ingestSource` from the auth source (device token →
`agent`, Clerk session → `browser`), keeps `engineVersion` only for browser
uploads (both on the slim game row), and never caps device uploads.

## Local storage

All of it lives in one IndexedDB database, `sc2tools-instant` (version 1).
Only the `/try` games a visitor chooses to save are ever sent anywhere:

| Store | Key | Holds | Lifetime |
| --- | --- | --- | --- |
| `tryGames` | `gameId` | `/try` parsed payloads (`json`, `date`, `engineVersion`, `storedAt`, `expiresAt`); at most 100 (`MAX_STORED_TRY_GAMES`, oldest-stored dropped) | Expire after 7 days (`TRY_TTL_MS`) and are deleted the next time `/try` reads them (not by a timer). Emptied by **Clear local data** on `/try` and after a successful save to an account. |
| `ledger` | relative path | Folder Sync / folder import status per file: `size`, `lastModified`, `uploaded`/`skipped`/`failed`, `gameId`, `errorKind`, `attempts`, `toons`, `updatedAt` | Until **Stop syncing** (Chrome/Edge) or **Forget import history** (other browsers), or until another account claims Folder Sync in this browser |
| `handles` | `folder` | The Folder Sync directory handle (read-only permission), bound to the account in `meta.folderOwner` | Until **Stop syncing** |
| `meta` | name | `lastFolderScanAt`, `folderOwner` (Clerk user id the Folder Sync state belongs to), `browserIngestPausedUntil` (per-account daily-cap pause) | Owner and scan time until **Stop syncing**; the pause until it passes |

Everything read back is validated: rows with an unknown shape, and error
kinds this app version does not know, are dropped. Clearing the site's data
in the browser removes the whole database.

## Original replay backup

Backup is optional and offered only by the signed-in import panel
(`BrowserImportPanel`), never by `/try` or Folder Sync. Its "Also back up
original replay files" checkbox appears only when
`GET /v1/me/replay-archive-status` returns `enabled: true`
(`REPLAY_FILES_STORE=r2`) and `browserUploadReady: true` (see
[Browser replay backup](#browser-replay-backup)), and is then **checked by
default**, like the agent; the panel's intro says a private copy of each
file is uploaded while it is ticked. Digests are computed only while it is checked. Backup covers only the
games the server accepted, skips files over 5 MiB (the server's
`REPLAY_FILE_MAX_BYTES`) and files the server already stores, and uses the
agent's three-step protocol (`replayBackup.ts`) strictly one file at a time:

1. `POST /v1/games/{encodeURIComponent(gameId)}/replay-upload` with
   `{filename, sizeBytes, sha256, md5}`. The digests are computed in Python
   in the worker (`replay_digests`). The API returns a signed PUT
   (`{url, headers, uploadId, expiresIn}`), or `{alreadyStored: true}`.
2. `PUT` the original bytes to the signed R2 URL with the returned headers,
   minus `content-length`, which browsers set themselves.
3. `POST …/replay-upload/complete` with `{uploadId}`. The API checks size,
   SHA-256 metadata and the MPQ header, then promotes the object.

Busy, 5xx and network errors back off (2 s doubling to 60 s, full jitter,
bounded attempts). Invalid requests and unknown games are skipped. Auth
failure, `replay_storage_unavailable`, a PUT blocked by the browser, or an
abort stops the run.

### Browser replay backup

The browser PUTs straight to the **private** replay bucket, so that bucket
needs a CORS rule that allows `PUT` from the site's origins with the signed
headers. Without it the browser blocks the PUT, which page script sees only
as a `TypeError`. Two safeguards keep a missing rule from being hidden or
retried:

- **Gating.** The backup checkbox appears only when
  `GET /v1/me/replay-archive-status` returns `enabled: true` **and**
  `browserUploadReady: true` (missing counts as `false`). The API sets
  `browserUploadReady` only after its own browser-style check passes (see
  below).
- **Fail fast.** If a PUT still throws a `TypeError`, `replayBackup.ts` stops
  after that single attempt with `stoppedReason: "unavailable"` instead of
  retrying every file. The games stay imported, and the summary says, in
  neutral words: "Your games were imported. Original-file backup isn't
  available right now, so no replay files were uploaded."

**Automatic setup (default).** With `REPLAY_FILES_STORE=r2`, the API
(`apps/api/src/services/replayFilesCors.js`) checks the rule in the
background after it starts listening:

1. It reads the bucket's CORS configuration. If no rule already allows PUT
   with the four signed headers from every exact `http(s)` origin in
   `CORS_ALLOWED_ORIGINS` (wildcards dropped, localhost only outside
   production), it writes the rule `sc2tools-browser-replay-upload` next to
   **every existing rule** (only an older copy of that one rule is
   replaced), then reads the configuration again to confirm it.
   `R2_BROWSER_CORS_AUTO=0` skips this write.
2. It verifies the rule the way a browser would: an `OPTIONS` preflight from
   each site origin (up to four), with `Access-Control-Request-Method: PUT`
   and the four signed headers, sent to the same host and path style as the
   signed PUT URLs (a probe key under `<R2_REPLAY_PREFIX>-pending/_cors-probe/`).
   Nothing is uploaded. Only a passing preflight counts as ready. After a
   fresh write it checks again 30 s later, the longest delay R2 documents
   for a CORS change.
3. It caches the result, logs one `replay_files_browser_cors` line
   (`{status, configured}`), and checks again in the background every 10
   minutes (every 2 minutes while Admin Health is open).

Writing the rule needs an R2 key that is allowed to change bucket settings.
A bucket-scoped **Object Read & Write** token is not, and the status then
reads `no_permission`. Use the manual steps below instead.

**Status card.** Admin → Infrastructure → Operational health →
**Browser replay backup** (`runtime.replayFilesBrowserUpload` in
`GET /v1/admin/health`) shows:

| Status | Card | Meaning |
|---|---|---|
| `ready` | green **Ready** | The preflight passed, so browsers can back up originals. |
| `missing_cors` | amber **Needs setup** | The preflight was refused. The detail line says why (for example, automatic setup is off). |
| `no_permission` | amber **Needs setup** | The R2 key can't change bucket settings. Add the rule by hand. |
| `error` | amber **Check failed** | The check could not finish (timeout, network). The detail line names the error code. |
| `disabled` | grey **Off** | `REPLAY_FILES_STORE` is not `r2`. |
| `unknown` / `checking` | grey **Checking…** | The first check has not finished yet. |

Every checked state also shows "checked … ago".

**Manual fallback (Cloudflare dashboard).**

1. Open the Cloudflare dashboard and choose **R2 Object Storage**.
2. Select the private replay bucket (the API's `R2_BUCKET`).
3. Open the **Settings** tab.
4. Under **CORS Policy**, choose **Add CORS policy**, or **Edit** if a policy
   already exists.
5. Open the **JSON** tab and paste the array below. If the bucket already has
   rules, add this object to the existing array instead of replacing them.
6. Choose **Save**. Keep Admin Health open: it re-checks every 2 minutes and
   the card turns **Ready** within a few minutes (or right after the next API
   deploy). Signed-in imports offer the backup again once the card is ready.

```json
[
  {
    "AllowedOrigins": ["https://sc2tools.com", "https://www.sc2tools.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "cache-control", "content-md5", "x-amz-meta-sha256"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedOrigins` must list the origins in the API's `CORS_ALLOWED_ORIGINS`.
The two above are the production site. Add a staging origin if you have
one, and `http://localhost:3000` only on a development bucket. The rule
grants no read access and does not make the bucket public. Each signed URL
still scopes one PUT to one pending object for five minutes (the API
default).

## Browser vs agent

The full picture behind the in-app comparison (`BrowserVsAgentTable`):

| | Browser (Instant Analysis) | Windows agent |
| --- | --- | --- |
| Analyze replays, every analyzer tab | ✓ | ✓ |
| Same game data (byte-identical payload) | ✓, except the SC2Pulse fields, which the server fills in later | ✓ |
| No install | ✓ | ✗ |
| Works on Mac, Linux, Chromebook, iPad | ✓ (desktop Chromium tested; see [limitations](#known-limitations)) | ✗ (Windows only) |
| Sync new games automatically | Folder Sync when you open or return to the dashboard (Chromium) | ✓, in the background while you play |
| Live pre-game scouting and OBS overlay data | ✗ (a web page cannot read the SC2 client API on `localhost:6119`) | ✓ |
| Accurate (engine) playback capture | ✗ (needs StarCraft II installed) | ✓ (opt-in) |
| OBS scene switching | ✗ | ✓ |
| Original replay archive | Signed-in import only, a checkbox that is on by default when the server stores originals (never from `/try` or Folder Sync) | Automatic when the server stores originals |

## Privacy

- **Replay files stay on the device.** They are read in place. `/try`
  uploads nothing until the visitor saves the games to an account, and then
  only the parsed game data. A signed-in import uploads the parsed game data
  (the same data the agent sends), plus the original files when the backup
  checkbox is left checked. Folder Sync uploads parsed data only.
- **Self-hosted runtime.** Pyodide and the engine are served from the site's
  own origin. No third-party CDN sees the visitor or runs code in the page.
- **No names in logs or telemetry.** Python's stdout and stderr are
  discarded and the worker never logs; the entry point's log lines carry only
  counts, timings, sizes and error kinds, and error details are class names
  plus fixed text.
- **Folder Sync state is per account.** It syncs only into the account that
  set it up in this browser (see [Folder Sync](#folder-sync-chromium-desktop)).
- **Analytics** (GA4, only after cookie consent; `lib/instant/analytics.ts`):
  `instant_open`, `instant_files_selected {count, source}`,
  `instant_parse_done {ok, failed, median_ms}`, `instant_report_view`,
  `instant_signup_click`, `instant_upload_done {games}`,
  `instant_folder_sync_resume` and `instant_error {kind}` (`kind`: an
  `ErrorKind`, `upload_<stop reason>`, `storage_unavailable` or
  `folder_permission_denied`). Only counts, timings, fixed codes and the
  intake source. The privacy policy (`app/legal/privacy/page.tsx`) covers
  in-browser parsing and the IndexedDB data.

## Rollout

`NEXT_PUBLIC_INSTANT_IMPORT` (`lib/instant/flag.ts`) is inlined at build
time, so change it on Vercel, then redeploy. The page and the prebuild both
read it trimmed and case-insensitively, so `All` also requires the engine.

| Value | Who sees it |
| --- | --- |
| `off` (default; also any unrecognised value) | Nobody. Entry points are hidden and `/try` returns 404. |
| `admins` | Signed-in accounts whose `/v1/me` has `isAdmin: true`. Everyone else, signed-out visitors included, gets a "Coming soon" panel on `/try` (not indexed) and no entry points. |
| `all` | Everyone, including anonymous `/try`. |

1. **`off`.** The prebuild still builds the engine when Python is available,
   but a failure does not fail the deploy.
2. **`admins`.** The engine build becomes required. Dogfood signed-in
   imports and Folder Sync; watch `ingestSource: "browser"` rows,
   `instant_error` kinds and the `browser_ingest_daily` counts.
3. **`all`.** Open `/try` and the entry points to everyone. The landing
   replay demo still POSTs to `/v1/public/preview-replay` (its copy says
   so); moving it onto the in-browser engine and retiring that route is
   follow-up work.

The API needs no flag; the daily cap is its safety valve. **Rollback:** set
the flag to `off` and redeploy. Browser-uploaded games stay valid and are
identifiable by `ingestSource: "browser"` and `engineVersion`.

## Budgets

Targets for the in-browser engine. "Measured" is filled in on reference
hardware; the parse-time fixture is a 15-minute 1v1 ladder replay.

| Budget | Target | Measured |
| --- | --- | --- |
| Cold start (first visit: download + compile + import) at 50 Mbit/s | ≤ 6 s | **3.6 s** (median of 3, range 3.58–3.70 s). Downloading 7.6 MB (14.6 MB decoded) takes 1.5 s, starting Python 1.8 s and importing the engine 0.13 s. |
| Warm start (repeat visit, assets in the HTTP cache) | ≤ 1 s | **2.3 s, not met** (median of 9, range 2.19–2.42 s). Reading the assets from the cache takes 0.07 s, SHA-256 and the Pyodide JS 0.12 s, starting Python 1.86 s and importing the engine 0.14 s. Starting Python is CPU work that no cache removes. **Mitigation:** the boot starts on the visitor's first intent (see step 2 of `/try`), so it mostly overlaps the file dialog; the time from choosing files to the analysis starting is not re-measured. The next step is a Pyodide memory snapshot. |
| Median parse, 15-minute 1v1 | ≤ 3 s | **1.19 s**: the 18-minute TvZ fixture through `/try`, median of 5 (1.11–1.30 s). It takes 5.3 s with the CPU about 4.4× slower. |
| Worker memory | ≤ 700 MB | **75 MiB** WebAssembly heap after 40 parses on one worker, with no growth after the first 20. The renderer process grows by 201 MiB RSS (173 → 374 MiB, median of 4). |
| New server CPU for parsing | 0 | **0.** The browser sent no request to the API. After the visitor picks replays, `/try` fetches only static files (`/_next/static`, `/pyodide`, `/engine`) and Next's prefetch of the prerendered `/download` page. |

**How measured (2026-09-28).** A cloud container, not a 2020 laptop: a KVM
guest (Intel Xeon @ 2.10 GHz, 4 vCPUs, 16 GB RAM), headless Chromium 141, a
production build served gzipped by `next start`, Playwright on the real
`/try` page, and the network throttled to 50/10 Mbit/s with 20 ms latency.
Start time runs from the file-input `change` event to the worker's `ready`
(cold: new profile; warm: revisit). Parse times are the worker's per-file
`ms`; the 4.4× slower CPU run throttled the main thread 4× over DevTools and
the rest of the renderer with a cgroup CPU quota. Memory is the WebAssembly
heap plus the renderer's RSS while 25 replays were analyzed twice. Main thread: no
long task over 50 ms in 3 end-to-end runs (longest stretch about 43 ms);
on a 4× slower main thread, rendering the report, saving the games and
handling the selection each take 50–100 ms. A cold visit at 50 Mbit/s,
landing page to report for 10 replays, took 12.0 s (median of 3). The
site's stats widget calls `/api/site/stats` on every page; nothing else
reached the server. The measurement scripts are not in the repository.

## Upgrading Pyodide or the engine

### Bump Pyodide

1. In `apps/web`: `npm install --save-dev --save-exact pyodide@<version>`.
   The pin must be exact, and `package-lock.json` changes with it.
2. Set `PYODIDE_VERSION` in `lib/instant/engineVersion.ts` to the same value.
   The `version-check` workflow and the build both fail on drift.
3. Check that the loader still accepts the options `engineBoot.ts` relies on
   (`createPyodideModule`, `stdLibURL`, `lockFileContents`, `indexURL`), that
   the four files in `PYODIDE_ASSETS` (`browser-engine/config.mjs`) still
   exist, and that its ESM still probes `importScripts` the way
   `withImportScriptsHidden` expects.
4. `npm run engine:build` recompiles the `.pyc` inside the new Pyodide and
   copies `lockInfo` from its `pyodide-lock.json`, under a new
   `/pyodide/<version>/` path.
5. Regenerate the CPython goldens and run the Pyodide parity test
   ([Testing](#testing)); the envelopes, upload `json` included, must match.

### Bump the engine

1. Update `apps/replay-engine/VERSION` and `INSTANT_ENGINE_VERSION` in
   `lib/instant/engineVersion.ts` together. Browser uploads carry this value
   as `engineVersion`.
2. If the pipeline imports a new module, add it to `AGENT_MODULES` or
   `CORE_MODULES` (which make up `BUNDLE_FILES`) in
   `scripts/browser-engine/files.mjs`. The build's smoke parse and
   `test:engine` fail if a module on their path is missing.
3. If the Python ↔ worker message shapes change, bump `ENGINE_PROTOCOL` in
   `instant_analysis.py` and `engineVersion.ts` together.

No cache purge is ever needed: bundle paths are content-addressed and only
`/engine/current.json` is revalidated. A tab opened before the deploy gets
`engine_unavailable` ("engine updated; reload the page") on its next boot if
the engine version or protocol changed, never a mismatched engine.

## Testing

| Layer | Command | What it proves |
| --- | --- | --- |
| Python parity | `cd apps/agent && python -m pytest tests/test_instant_analysis.py -ra` | Every fixture × every human perspective × both data views (`installed`, `source`, run in fresh interpreters by `tests/instant_golden.py`). Only the two Pulse fields differ from the desktop path. The sandbox-flag desktop call is byte-identical. Name, folder, mtime and toon-folder variants give identical JSON. Logs never contain file or folder names. Error kinds match `types.ts`. |
| Pyodide parity | `python apps/agent/tests/instant_golden.py --out /tmp/instant-golden`, then in `apps/web`: `npm run engine:build && INSTANT_GOLDEN_DIR=/tmp/instant-golden npm run test:engine` | The built bundle's assets match the manifest. The worker's real Python glue in Pyodide gives envelopes identical to CPython's, including the upload `json`, and unzips entries with their stored times. `tests/engine/required.test.mjs` checks the prebuild reads the flag like the app. |
| Web units | `cd apps/web && npx vitest run lib/instant components/instant` | Boot and integrity (mocked worker), client queue, timeouts and recycling, intake, identity, IndexedDB (`fake-indexeddb`), batching, uploader, backup, report, flag, analytics and components. |
| API | `cd apps/api && npx jest __tests__/gamesBrowserIngest.test.js __tests__/gamesExists.test.js __tests__/browserIngestQuota.test.js __tests__/gamesIngestPolicy.test.js __tests__/replayFiles.test.js` | Provenance stamping, the exists route, the daily cap, ingest policy and Clerk-session backup. |
| End to end | Build with `NEXT_PUBLIC_INSTANT_IMPORT=all`, then `NEXT_PUBLIC_INSTANT_IMPORT=all npx playwright test try-instant --project=desktop-1280` (`tests/e2e/try-instant.spec.ts`, tagged `@slow`; it skips itself without the flag) | The real engine in Chromium: drop a fixture on `/try`, get a report, and no request reaches the API origin. |

CI: `python-tests.yml` → `instant-parity` runs the Python parity suite in a
venv holding **only** sc2reader and pytest, then builds the bundle and runs
`test:engine` against the goldens. `web-ci.yml` builds with
`NEXT_PUBLIC_INSTANT_IMPORT=all` and `INSTANT_ENGINE_REQUIRED=1`, so a
broken engine build fails the PR. `version-check.yml` pins the versions.

## Known limitations

- **Firefox and Safari are untested.** The classic worker imports its
  verified modules with dynamic `import()` of `blob:` URLs; only Chromium is
  covered by Playwright.
- **iOS and iPadOS memory.** Mobile Safari kills pages and workers far below
  desktop limits, so long batches can hit `out_of_memory` (the worker is
  replaced and the batch continues), and very long games may not fit.
- **Agent-only features.** Pre-game scouting, overlay data, OBS scene
  switching, syncing without a tab open and accurate engine playback need
  the agent (see [Browser vs agent](#browser-vs-agent)).
- **No SC2Pulse at parse time.** Pulse links arrive via the server crons;
  MMR enrichment covers at most the last 30 days (ADR 0019).
- **Custom builds are not applied locally**, matching the installed agent.
- **Folder Sync** needs a Chromium desktop browser and runs only when the
  dashboard is opened or returned to; the browser may ask to re-grant
  folder access on a later visit.
- **First-visit download** of about 7.6 MB over the wire (14.6 MB decoded),
  cached immutably afterwards.
- **No interrupt.** Without cross-origin isolation, a stuck parse costs up to
  60 s before the worker is replaced.
