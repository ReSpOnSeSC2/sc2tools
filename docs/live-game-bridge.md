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
                user's PC                                  cloud (Render/Vercel)              streamer's OBS / Streamlabs       streamer's web /app tab
                ─────────                                  ───────────────────────────         ─────────────────────────────     ────────────────────────

SC2 game ──► localhost:6119 ──► Desktop Agent ──► HTTPS ─► api.sc2tools.com /v1/agent/live ─┬─► Socket.io overlay:<token> ───► Browser Source widget
                                (sc2tools-agent.exe)         (LiveGameBroker)                ├─► Socket.io overlay:<token> ───► Browser Source widget (more)
                                                                                              └─► SSE /v1/me/live ─────────────► /app dashboard panel
```

**Local agent reports outward; cloud broadcasts.** Internalize that
before reading further — every later design decision falls out of it.
The website never reaches into the user's PC; the user installs only
the desktop agent, no Node.js, no terminal.

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

### Cloud API (default, supported)

`POST /v1/agent/live` (in
[apps/api/src/routes/agentLive.js](../apps/api/src/routes/agentLive.js))
hands the envelope to an in-process `LiveGameBroker`
([apps/api/src/services/liveGameBroker.js](../apps/api/src/services/liveGameBroker.js))
which fans the envelope out to two surfaces:

1. **Hosted overlay (Socket.io ``overlay:liveGame``).** Per-token
   emit to every active overlay token belonging to the publishing
   user. Each `sc2tools.com/overlay/<token>/widget/<name>` Browser
   Source the streamer pasted into OBS receives the envelope and
   updates its widget progressively (see §5).
2. **Per-user SSE (``GET /v1/me/live``).** Streams envelopes to the
   web dashboard so the `/app` tab can show a "live game in
   progress" card (`apps/web/components/dashboard/LiveGamePanel.tsx`)
   alongside whatever else the user is doing.

Auth: device-token Bearer (POST), Clerk session (SSE).

The broker keeps the latest envelope per user for up to 30 minutes
so a tab opened mid-match shows widgets immediately rather than
blanking until the next 1 Hz tick.

### Local overlay backend (legacy, opt-in)

`POST http://localhost:3000/api/agent/live` against the legacy
self-hosted product
([reveal-sc2-opponent-main/stream-overlay-backend](../reveal-sc2-opponent-main/stream-overlay-backend))
re-broadcasts the envelope on a Socket.io channel for that product's
own widgets. **This transport is OFF by default** in the cloud-shipped
agent. Set the `SC2TOOLS_LOCAL_OVERLAY_URL` env var (e.g.
`SC2TOOLS_LOCAL_OVERLAY_URL=http://localhost:3000`) to enable it. The
runner then constructs an `OverlayBackendTransport` alongside the
default `CloudTransport` and fans every envelope to both. Cloud-only
installs ship zero traffic to localhost:3000.

Both transports are token-bucket rate limited to 4 msg/s and lossy by
design — the bridge fires payloads at ~1 Hz; if a single POST fails,
we drop it and rely on the next poll's fresh data.

## 5. Widgets

Hosted Browser Source widgets (`apps/web/app/overlay/[token]/widget/[name]`)
listen on two Socket.io events:

* `overlay:live` — post-game `LiveGamePayload`, derived by the cloud
  from the replay-parsed game record. Carries head-to-head, recent
  games, best-answer, cheese probability — the rich data only
  available once a replay lands.
* `overlay:liveGame` — pre/in-game `LiveGameEnvelope` from the agent,
  fanned out by the broker. Carries opponent identity, race, optional
  Pulse profile (MMR, league).

When both are present for the same `gameKey` the post-game payload
wins — it's authoritative and strictly carries more data.

Lifecycle phase (`liveGame.phase`) drives display state:

* `idle` / `menu` → hide opponent + scouting widgets
* `match_loading` → render skeleton + opponent name + race
* `match_started` → render full live data (incl. MMR once Pulse responds)
* `match_in_progress` → tick the in-game clock
* `match_ended` → render Victory/Defeat cue (replaced by replay-derived
  `overlay:live` payload ~30 s later)

The widget visibility timer in
[apps/web/components/OverlayWidgetClient.tsx](../apps/web/components/OverlayWidgetClient.tsx#L256)
keeps opponent + scouting pinned for the whole match while a non-idle
envelope is current, and falls back to the per-widget natural duration
once the bridge clears.

## 6. Voice readout

[apps/web/components/overlay/useVoiceReadout.ts](../apps/web/components/overlay/useVoiceReadout.ts)
fires the scouting / matchStart / matchEnd / cheese readouts. Two
trigger sources:

1. Post-game `LiveGamePayload` — full payload, fires the rich
   scouting line (name, race, H2H, best answer, cheese hint).
2. Pre-game `LiveGameEnvelope` — fires a trimmed scouting line (name,
   race, MMR if known) the moment the agent reports MATCH_LOADING.
   Suppressed when the post-game payload is present so the streamer
   never hears two readouts for the same match.

Both paths share the per-trigger fingerprint dedup (`gameKey` for the
live-envelope path), so a single match's 5+ envelope deltas only
speak once.

Persisted unlock (localStorage key `sc2tools.voiceUnlocked`) survives
OBS Browser Source refreshes; without it the streamer would have to
right-click → Interact → click each time OBS reloaded the source.

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

The cloud's broker exposes per-publish counters on
`liveGameBroker.counters`:

| Counter | Meaning |
|---|---|
| `published` | Total `publish()` calls |
| `sse_emit_ok` / `sse_emit_failed` | SSE subscriber callback outcomes |
| `overlay_emit_ok` / `overlay_emit_failed` | Per-token Socket.io emit outcomes |

`AgentStatusIndicator` in Settings → Overlay reads from the same SSE
stream the dashboard does and renders green / grey based on whether
a fresh envelope arrived in the last 10 / 60 s.

## 8. Failure modes (graceful degradation)

| What's down | What still works |
|---|---|
| Source A (`localhost:6119`) | Existing `opponent.txt` legacy path. Bridge stays IDLE. |
| Source B (Pulse) | Bridge emits opponent name + race from Source A. Scouting card shows "Looking up opponent…", then "Profile lookup unavailable" once Pulse responded without an MMR row. |
| Cloud API | OBS overlays go quiet (expected — same as a network outage). When cloud recovers, the next 1 Hz tick repopulates. |
| Agent crashed / not running | `AgentStatusIndicator` flips to grey "Agent offline". OBS widgets still show the most recent post-game `overlay:live` payload until it ages out. |
| Pulse timeout DURING the lookup | First emit (name + race) lands at T+50 ms; the Pulse-enriched re-emit never lands; widgets show "MMR unavailable" rather than spinning indefinitely. |

## 9. Manual smoke test

The end-to-end test plan (run before merging anything that touches
the bridge):

1. Install the agent — fresh `.exe` install, sign in to sc2tools.com.
2. Land on Settings → Overlay. Confirm `AgentStatusIndicator` flips
   to green within 5 s of the agent boot.
3. Copy the "Scouting widget" URL with the Copy button. Paste into
   OBS → Add Browser Source → URL → OK. Widget appears blank (no
   game yet).
4. Open SC2 → click Find Match. Within 2 s of the loading screen
   completing, the Scouting widget shows the opponent name + race
   (`live_emit phase=match_loading` in agent.log).
5. Within 4 s the scouting card shows MMR + matchup record (the
   second emit, triggered by the Pulse callback).
6. Voice readout speaks one coherent phrase.
7. Throughout the match, the opponent + scouting widgets stay
   visible (`live_emit phase=match_in_progress` lines tick once
   per second).
8. Open `sc2tools.com/app` in a separate browser tab during the
   match. The dashboard's `LiveGamePanel` shows "Live game vs
   <opponent> (<race>)" with the elapsed clock ticking. Card vanishes
   ~30 s after the last envelope.
9. After the match ends:
   * `live_emit phase=match_ended` with the player results.
   * Within 30 s, the replay lands and the post-game `overlay:live`
     payload fires, superseding the live record on the same
     `gameKey`.
   * Web tabs transition cleanly from "live" to "post-game".
10. Click "Send test event" next to "Scouting widget" in Settings →
    Overlay. The OBS widget lights up with sample data for ~10 s
    and auto-clears.
11. Revoke the overlay token. Within 5 s, the OBS widget receives
    no further events. Re-issue the token + update the OBS URL to
    restore.

## 10. Privacy

No screen pixels, no log files, no replay file contents leave the
user's machine via the live bridge — only the structured
`LiveGameState` JSON (opponent name, race, MMR, game time, lifecycle
phase). The Pulse lookup uses only the in-game opponent name; nothing
about the user is sent.

The cloud's `overlay:liveGame` event carries opponent data only —
the `user` block is intentionally limited to the streamer's display
name (no Pulse handle, no own MMR) so a leaked overlay token can't
exfiltrate the streamer's ladder identity.

## 11. Known limitations / out-of-scope follow-ups

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
