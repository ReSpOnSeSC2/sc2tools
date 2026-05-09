# Live Game Bridge

The Live Game Bridge is the real-time data path that feeds the OBS
overlay and the web app from a running StarCraft II match. It exists
because the legacy pipeline (`opponent.txt` + replay-only ingest) only
populates widgets *after* a replay lands, leaving the opponent and
scouting widgets blank during the game itself.

## 1. Why this shape

The website is hosted on Render. It cannot reach into the user's PC —
NAT, firewalls, dynamic IPs, ISP-blocked inbound ports — so a "cloud
polls localhost" design is dead on arrival.

The bridge follows the same pattern the existing replay-upload flow
uses, and the same pattern Discord Rich Presence / Steam friends
activity / Spotify "Now Playing on web" / Twitch metadata all use:

```
SC2 game ──► localhost:6119 ──► Desktop Agent ──► outbound HTTPS ──► Cloud API ──► SSE ──► /app tabs
                (Blizzard)        (Python tray app)                  (Render)              (browser)
                                            │
                                            └─► outbound HTTP ─► localhost:3000 ─► Socket.io ─► OBS overlays
                                                                  (overlay backend)
```

**Local agent reports outward; cloud broadcasts.** Internalize that
before reading further — every later design decision falls out of it.

## 2. Sources of truth

The bridge fuses two independent sources, each authoritative for what
it can answer:

### Source A — Blizzard SC2 Client API (`http://localhost:6119`)

Undocumented but stable HTTP API the SC2 client serves on localhost
whenever the game is running. Used by community OBS overlays for
years. Two endpoints we touch:

* `GET /game` — list of `players` (name, race, type, result),
  `displayTime`, `isReplay`. The earliest source of in-match opponent
  data — populated as soon as the loading screen finishes.
* `GET /ui` — `activeScreens` array. Distinguishes
  `ScreenLoading` / in-game / `ScreenScore` / `ScreenHome`.

Polled at 1 Hz (250 ms during transitions). See
[apps/agent/sc2tools_agent/live/client_api.py](../apps/agent/sc2tools_agent/live/client_api.py)
for the `LiveClientPoller` and the lifecycle state machine.

### Source B — SC2Pulse (`https://sc2pulse.nephest.com/sc2/api`)

Free community ladder API. Two endpoints we touch:

* `GET /character/search?term=<name>` — name search → 0..N candidates
  with character ID, region, account handle, per-race game counts.
* `GET /group/team?characterId=<id>&season=<id>&queue=LOTV_1V1` —
  current 1v1 team rating (MMR + league).

Plus a one-shot `GET /season/list/all` to discover the current
ladder season ID.

Resolution policy (region preference, race tiebreaker, partial-failure
fallback) lives in
[apps/agent/sc2tools_agent/live/pulse_lookup.py](../apps/agent/sc2tools_agent/live/pulse_lookup.py).

## 3. The bridge

[apps/agent/sc2tools_agent/live/bridge.py](../apps/agent/sc2tools_agent/live/bridge.py)
fuses both sources into a single `LiveGameState` dict and publishes
it on its own bus. Subscribers (the transports) ship the dict
outbound.

Key behaviours:

1. **Sub-second emit at MATCH_LOADING.** As soon as Source A reports
   the loading screen with a populated player list, the bridge emits
   a partial envelope (name + race) so widgets render at T+~50 ms.
2. **Pulse runs in parallel.** The bridge dispatches the Pulse
   lookup to a worker thread; when the result lands (typically
   150–500 ms cold, <10 ms warm) it patches the cached context and
   re-emits an enriched envelope. Each emit is a delta with the
   same `gameKey`.
3. **Late Pulse responses for old games are dropped.** If the user
   starts a second game while a Pulse lookup is still in flight,
   the late response sees a `gameKey` mismatch and is discarded —
   no cross-game payload pollution.
4. **`gameKey` reconciles with replays.** Synthesised from sorted
   player names + match-start ms. The post-game replay parse
   uploads its own gameId; the cloud reconciles by checking name
   overlap + ±5 min timestamp proximity.

## 4. Transports

Two parallel transports subscribe to the bridge's output bus, each
with independent retry / failure semantics. Failure of one does not
block the other:

### Local overlay backend

`POST http://localhost:3000/api/agent/live` (added in
[reveal-sc2-opponent-main/stream-overlay-backend/index.js](../reveal-sc2-opponent-main/stream-overlay-backend/index.js))
re-broadcasts the envelope on the existing `overlay_event`
Socket.io channel. The backend ALSO derives `opponentDetected` and
`scoutingReport` events from the same payload so widgets that
pre-date the new `liveGameState` handler still light up at
MATCH_LOADING.

Auth: optional shared secret via `SC2TOOLS_LIVE_AGENT_TOKEN` env
var. When set, requests must carry a matching
`X-SC2Tools-Agent-Token` header. When unset (default), accepts
anonymous (matching the legacy posture for the localhost backend).

Token-bucket rate limited to 4 msg/s per transport.

### Cloud API

`POST /v1/agent/live` (added in
[apps/api/src/routes/agentLive.js](../apps/api/src/routes/agentLive.js))
hands the envelope to an in-process `LiveGameBroker`
([apps/api/src/services/liveGameBroker.js](../apps/api/src/services/liveGameBroker.js))
which fans it out over `GET /v1/me/live` Server-Sent Events to
every web tab the user has open.

Auth: device-token Bearer (POST), Clerk session cookie (SSE GET).

The broker keeps the latest envelope per user for up to 30 minutes
so a tab opened mid-match shows widgets immediately rather than
blanking until the next 1 Hz tick.

## 5. Widgets

Widgets read `liveGameState` directly (handler in
[reveal-sc2-opponent-main/stream-overlay-backend/public/_ov/app.js](../reveal-sc2-opponent-main/stream-overlay-backend/public/_ov/app.js))
and ALSO continue to consume the legacy `opponentDetected` /
`scoutingReport` events. The lifecycle phase drives display state:

* `idle` / `menu` → hide opponent + scouting widgets
* `match_loading` → render skeletons + opponent name + race
* `match_started` → render full data
* `match_in_progress` → tick the in-game clock
* `match_ended` → render Victory/Defeat (replaced by replay-derived
  data when the replay lands, ~30 s later)

## 6. TTS reliability

[reveal-sc2-opponent-main/stream-overlay-backend/public/_ov/voice-readout.js](../reveal-sc2-opponent-main/stream-overlay-backend/public/_ov/voice-readout.js)
gained:

* **Persisted unlock.** First user gesture writes
  `localStorage.sc2tools.voiceReadout.gestureUnlocked = '1'`. Subsequent
  reloads of the overlay don't re-prompt.
* **Silent-failure detection.** If `speak()` doesn't fire `onstart`
  within 2 s, the engine ate the request — cancel + retry once.
* **Diagnostics POSTs.** Failures POST to
  `POST /api/voice/diagnostics` so a dashboard / agent telemetry
  endpoint can surface "your overlay's voice readout is broken"
  rather than the streamer hearing nothing and not knowing why.
* **`?voice=test` query.** Speaks a one-shot diagnostic phrase on
  load so streamers can validate audio without queueing a real
  ladder match.

Settings → Voice
([apps/web/components/analyzer/settings/SettingsVoice.tsx](../apps/web/components/analyzer/settings/SettingsVoice.tsx))
gained:

* The same silent-failure timer as the overlay so Settings → Test
  reproduces the same failure mode the streamer sees in OBS.
* An autoplay-blocked banner (with a Retry button) for the
  `not-allowed` error code.

## 7. Observability

[apps/agent/sc2tools_agent/live/metrics.py](../apps/agent/sc2tools_agent/live/metrics.py)
exposes a process-wide `METRICS` singleton. Every external call
increments counters + observes latency:

| Counter | Meaning |
|---|---|
| `client_api.{ui,game}.{ok,unreachable,error,bad_status,bad_json,bad_shape}` | Per-call outcome on the localhost API |
| `pulse.resolve.{cache_hit,cache_miss,full,partial,unhandled_error}` | Pulse lookups |
| `transport.{overlay,cloud}.{ok,error,bad_status,skipped_unpaired}` | Outbound transport |
| `bridge.publish.<phase>` | Per-phase envelope counts |

EWMA latency samples (`*_latency`) live alongside.

`PeriodicMetricsLogger` dumps the snapshot to `agent.log` at INFO
every 5 minutes — grep for `live_metrics` to see trends.

## 8. Failure modes (graceful degradation)

| What's down | What still works |
|---|---|
| Source A (`localhost:6119`) | Existing `opponent.txt` legacy path. Bridge stays IDLE. |
| Source B (Pulse) | Bridge emits opponent name + race from Source A. Scouting card shows "Looking up opponent…". |
| Cloud API | OBS overlays keep working via the local Socket.io path. Web tabs go quiet until cloud recovers. |
| Local overlay backend | Web tabs still get live data via cloud SSE. |

## 9. Manual smoke test

The end-to-end test plan (run before merging anything that touches
the bridge):

1. Start the agent: `python -m sc2tools_agent --log-level=DEBUG`.
2. Confirm `live_event phase=idle` then `phase=menu` in `agent.log`.
3. Open SC2 → queue ladder → click Find Match.
4. Within 2 s of the loading screen completing, the opponent widget
   should show the opponent name + race (`live_event phase=match_loading`
   in agent.log).
5. Within 4 s the scouting card should show MMR + matchup record
   (the second emit, triggered by the Pulse callback).
6. Voice readout speaks a coherent phrase.
7. Throughout the match, the opponent widget stays visible
   (`live_emit phase=match_in_progress` lines tick once per second).
8. After the match ends:
   * `live_emit phase=match_ended` with the player results.
   * Within 30 s, the replay lands and the post-game `matchResult`
     event fires, superseding the live record on the same `gameKey`.
   * Web tabs transition cleanly from "live" to "post-game".

For each scenario in section 8 of
[docs/live-widgets-fix-prompt.md](./live-widgets-fix-prompt.md),
capture a screen recording before opening the PR.

## 10. Privacy

No screen pixels, no log files, no replay file contents leave the
user's machine via the live bridge — only the structured
`LiveGameState` JSON (opponent name, race, MMR, game time, lifecycle
event). The Pulse lookup uses only the in-game opponent name; nothing
about the user is sent.

## 11. Known limitations / out-of-scope follow-ups

(Carried forward from
[docs/live-widgets-fix-prompt.md](./live-widgets-fix-prompt.md) §9.)

* **OCR / UIA.** Considered + rejected. The localhost API gives us
  the same data structurally with zero CPU cost.
* **macOS / Linux.** Windows-first. The `live/` module is platform-
  agnostic; only the agent's tray UI / packaging are Windows-shaped
  today. No Windows-specific calls inside `live/`.
* **Replacing SC2Pulse with Blizzard's official OAuth API.** Pulse is
  sufficient and free.
* **Per-second build-order tracking via memory reads.** Much larger
  project. The localhost API + replay parse cover the realistic
  value.
