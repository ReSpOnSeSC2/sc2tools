# OBS Auto Scene Switching

Automatic OBS scene changes driven by real StarCraft II game state: cut
to the gameplay layout when a match starts, cut to a downtime layout
when it ends. Plus a one-click builder that creates those two layouts
from the sources the streamer already has.

## 1. Why it has to work this way

The obvious design is the one [`StreamSceneWidget`](../apps/web/components/overlay/widgets/StreamSceneWidget.tsx)
already uses for BRB / Starting Soon: a full-canvas Browser Source
painted over whatever scene is live, toggled by state.

That cannot deliver this feature. **A Browser Source can only draw
pixels inside its own rectangle.** It cannot move the streamer's
webcam, and it cannot shrink the game capture — those are OBS sources,
and only OBS can transform them. Any downtime layout where the camera
gets bigger and the game gets smaller requires programmatic OBS
control, which means obs-websocket.

So the split is:

| Concern | Where it lives |
|---|---|
| Knowing whether a game is running | Already solved — [`live/client_api.py`](../apps/agent/sc2tools_agent/live/client_api.py) |
| Deciding which scene should be live | [`live/obs_scene.py`](../apps/agent/sc2tools_agent/live/obs_scene.py) |
| Talking to OBS | [`live/obs_client.py`](../apps/agent/sc2tools_agent/live/obs_client.py) |
| Creating the layouts | [`live/obs_layout.py`](../apps/agent/sc2tools_agent/live/obs_layout.py) |
| Drawing the backdrop | [`SC2BackdropScene.tsx`](../apps/web/components/overlay/scenes/SC2BackdropScene.tsx) |

## 2. Two scenes, not one retransformed scene

OBS lets the *same* webcam and *same* game capture appear in several
scenes at different sizes and positions. A scene item is a reference,
not a copy, so the duplicate costs no extra capture CPU.

That choice buys three things that in-place retransforming does not:

1. **The streamer's own transition plays.** Fade, stinger, whatever
   they configured — for free, with no frame-stepping over a
   websocket.
2. **Their existing scenes are never mutated.** Auto-switching only
   ever calls `SetCurrentProgramScene`, which is read-only with
   respect to scene *contents*.
3. **Crash safety.** If the agent dies mid-stream, OBS is parked on a
   valid scene. A half-completed transform leaves a broken layout on
   air.

## 3. Data path

```
SC2 client ──► localhost:6119 ──► LiveClientPoller ──► lifecycle bus
                                                            │
                                                       LiveBridge
                                                            │
                                                      bridge.bus
                                          ┌─────────────────┼─────────────────┐
                                    CloudTransport   ObsSceneController   log subscriber
                                     (overlay)              │
                                                      ObsClient ──ws──► OBS :4455
```

The controller is just one more `bridge.bus.subscribe(...)` beside the
existing transports, wired in `runner._build_obs_switcher()`.

## 4. Phase → scene mapping

Defaults, all independently overridable in the agent's Settings tab.
An empty value means "leave the scene alone for this phase", so a
streamer who only wants two scenes configures two rows.

| Phase | Default scene | Notes |
|---|---|---|
| `idle` | Between Games | SC2 isn't running |
| `menu` | Between Games | the downtime layout |
| `match_loading` | In Game | cut early, before the map appears |
| `match_started` | In Game | no-op, already there |
| `match_in_progress` | In Game | no-op |
| `match_ended` | In Game | **deliberate** — see below |

`match_ended` holding the gameplay scene is not an oversight. The score
screen is worth showing; the cut to the downtime layout happens when
the phase drops to `menu`, which is when the streamer actually leaves
the match.

### Behaviours that matter on air

**Edge-triggered on the resolved scene, not the phase.** The bridge
fires at ~1 Hz and re-emits whenever a Pulse lookup lands. Comparing
the resolved scene collapses all of that into one
`SetCurrentProgramScene` per real transition — a five-minute game
issues one request, not three hundred.

**The leave-debounce is a deadline, not a counter.** The poller
de-duplicates `IDLE` and `MENU` (`client_api.py` only emits them when
`_last_phase` differs), so "wait for N consecutive observations" would
wait forever. Instead a leaving phase arms a deadline (default 3 s) and
any active phase disarms it. This is what stops a dropped
`localhost:6119` poll, an alt-tab, or the in-game options menu from
yanking the layout mid-game.

**Entering a match is never debounced.** The cut has to land before the
map fades in.

**Replays are suppressed.** Replay playback reports the same lifecycle
phases a real match does. Off by default, toggleable.

**Manual overrides win.** A program-scene change the agent did not
initiate parks auto-switching until the next *phase change* — not a
timer, which would either fight the streamer or give up too early.

## 5. The layouts

Geometry is authored against a 1920×1080 reference and scaled by
whatever `GetVideoSettings` reports, so 1440p and 4K land correctly.
Sizing uses `OBS_BOUNDS_SCALE_INNER`, so a 720p and a 1080p webcam both
fill their box without the builder knowing which is plugged in.

### SC2 Tools — Between Games

| Item | x | y | w | h | z |
|---|---|---|---|---|---|
| SC2 backdrop (browser) | 0 | 0 | 1920 | 1080 | 0 |
| Webcam | 48 | 48 | 1224 | 688 | 1 |
| Game capture inset | 48 | 760 | 484 | 272 | 2 |
| Session stats (browser) | 556 | 760 | 716 | 272 | 3 |
| Chat (browser) | 1320 | 48 | 552 | 984 | 4 |

Big camera and a full-height chat column dominate. The game inset is
small but stays legible enough to read a matchmaking screen — which is
the entire reason it is on screen.

The three browser panels point at the user's own overlay URLs:
`/overlay/<token>/scene/between-games`, `/overlay/<token>/widget/session`
and `/overlay/<token>/widget/multichat`. The latter two are existing
widgets, reused.

### SC2 Tools — In Game

Game capture full canvas, webcam at 304×171 bottom-right.

A streamer who already has a gameplay scene they like can skip this
half entirely and point the phase map at their own scene.

## 6. Builder safety contract

`obs_layout.py` is the only code in the agent that writes to a user's
OBS, and it runs against a live stream setup. So:

* It runs **only** on an explicit "Build my scenes" click, after a
  confirm dialog showing which sources will be used.
* It creates only scenes prefixed `SC2 Tools — `.
* It **never** edits, renames or deletes anything else. A pre-existing
  scene of ours is a hard error unless `rebuild` is set, and even then
  a second guard (`_assert_ours`) rejects removing any name without the
  prefix.
* Input-name collisions get a numeric suffix rather than aborting the
  build partway and leaving a half-populated scene behind.
* Everything it creates is an ordinary OBS scene. Edit it by hand
  afterwards — the builder is a starting point, not a managed resource.

Browser sources are created at their exact on-canvas pixel size (so
chat text rasterises crisply instead of being scaled up), with
`shutdown` and `restart_when_active` both **off**: a source that
reloads when its scene activates would flash on air every time the
switcher fires, which is many times a session.

## 7. Setup

### Single PC

1. OBS → **Tools → WebSocket Server Settings** → tick *Enable WebSocket
   server*. Note the port (4455) and click *Show Connect Info* for the
   password.
2. Agent → **Settings → OBS scene switching** → tick *Switch scenes
   automatically*, paste the password, click **Test connection**.
3. Click **Build my scenes…**, pick your webcam and game capture,
   confirm.
4. Select the new scenes in the phase dropdowns and **Save settings**.

### Two PCs (SC2 on the gaming rig, OBS on the stream rig)

Same, with two differences:

* obs-websocket v5 binds `0.0.0.0` by default, so no OBS-side change is
  needed — but the **stream PC's firewall** must allow inbound TCP on
  4455 from the gaming PC.
* Set **OBS host** to the stream PC's LAN address instead of
  `127.0.0.1`.

The agent runs on the gaming PC either way: it has to reach
`localhost:6119`, which only exists where SC2 is running.

## 8. Configuration reference

Stored in `%LOCALAPPDATA%\sc2tools\agent.json`; env vars win over the
file, matching the rest of the agent.

| State field | Env override | Default |
|---|---|---|
| `obs_scene_switch_enabled` | — | `false` |
| `obs_host` | `SC2TOOLS_OBS_HOST` | `127.0.0.1` |
| `obs_port` | `SC2TOOLS_OBS_PORT` | `4455` |
| `obs_password` | `SC2TOOLS_OBS_PASSWORD` | none |
| `obs_scene_map` | — | see §4 |
| `obs_switch_debounce_sec` | — | `3.0` |
| `obs_switch_on_replays` | — | `false` |
| `obs_transition_name` | — | none (leave OBS alone) |
| `obs_transition_duration_ms` | — | none |

`--no-obs` disables switching for one run without clearing the saved
settings, mirroring `--no-live`.

On credential storage, see
[ADR 0021](adr/0021-obs-credential-storage.md).

## 9. Observability

Counters land on the existing `METRICS` singleton, so
`PeriodicMetricsLogger` picks them up in the 5-minute `live_metrics`
line for free.

| Counter | Meaning |
|---|---|
| `obs.connect.{ok,refused,auth_failed}` | Connection outcomes |
| `obs.switch.ok` | Scene actually changed |
| `obs.switch.error` | Request failed or OBS disconnected |
| `obs.switch.scene_missing` | Configured scene not in OBS |
| `obs.switch.suppressed_{manual,debounce,replay}` | Deliberate non-switches |
| `obs.switch.latency` | Round-trip on `SetCurrentProgramScene` |
| `obs.build.ok` | Scene builds completed |

Grep `agent.log` for `obs_scene_switch` to see transitions:

```
obs_scene_switch phase=match_loading scene='SC2 Tools — In Game' reason=phase_change latency_ms=8
obs_connect_failed host=127.0.0.1 port=4455 consecutive=11 err=... (OBS may not be running...)
```

OBS simply not being open is the normal case, so connection failures
stay at DEBUG for the first 10 attempts, then log at most once a
minute.

## 10. Failure modes

| What's wrong | What happens |
|---|---|
| OBS closed | Switching silently no-ops; backoff reconnect 1 s → 30 s. Nothing else in the agent is affected. |
| Wrong password | One `auth_failed` line, then the connection thread parks. No retry storm. Fixed by re-saving in Settings, which reconnects. |
| Configured scene deleted/renamed | Warns once per scene name, skips that switch, keeps running. The GUI dropdown shows it as `(missing)` rather than silently resetting. |
| SC2 client API unreachable | Bridge stays IDLE, so no phase events, so no switching. |
| Agent crashes mid-stream | OBS stays on whatever scene was live. |
| Overlay token revoked | Existing scenes keep their layout; the browser panels go blank. Re-issue and rebuild. |

## 11. Manual smoke test

Run before merging anything that touches this path.

1. Enable the WebSocket server in OBS. Agent → Settings → OBS → **Test
   connection** reports the OBS version and a scene count.
2. **Build my scenes…** with a real webcam and game capture. Confirm by
   eye: camera large and correctly framed, chat readable, game inset
   legible enough to read a matchmaking screen, backdrop not fighting
   any of it.
3. Confirm your **pre-existing scenes are untouched** — diff the scene
   collection JSON before and after.
4. Map the phases, Save, then run
   `py -m sc2tools_agent --no-gui` with `SC2TOOLS_LOG_LEVEL=DEBUG`.
5. Click Find Match → OBS cuts to In Game **before** the map is
   visible. Exactly one `obs_scene_switch phase=match_loading` line.
6. During the match, the in-game line appears **once**, not once per
   second.
7. Alt-tab to the desktop mid-game → **no** switch.
8. Game ends → holds on the score screen, then cuts to Between Games
   when you return to the menu.
9. Queue again → the inset shows the matchmaking screen; session stats
   show real W/L and MMR.
10. Play back a saved replay → **no** switch fires.
11. Manually switch to a third scene mid-game → auto-switching holds
    until the next phase change, with a `suppressed_manual` line.
12. Force-quit OBS mid-stream → backoff logged, no crash, reconnects
    when OBS returns.
13. Sit on Between Games for 10 minutes with OBS's Stats dock open:
    CPU inside budget, render lag and skipped frames both 0.

## 12. Out of scope

Cloud-side OBS control (the agent talks to OBS directly — no
round-trip, and it works with the internet down). Audio, filters, or
source toggling beyond what the builder creates. Animating transforms
in place. Managing the scenes after creation.
