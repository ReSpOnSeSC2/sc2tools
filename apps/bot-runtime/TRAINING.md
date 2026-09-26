## Current status - September 26, 2026, 02:45 UTC

The richer replay data is connected to actual saved-checkpoint training. `full-curriculum-fit-v1` restored the exact parameters and Adam state from `balanced-fit-v2`, trained all 679 supported examples once plus 226 balanced opening rehearsals, and completed 905 updates in 251.65 seconds (3,017 cumulative). A separate observation-only reload reproduces all 64 checked predictions exactly. The earlier bounded v2 continuation added 1,024 updates and improved the original24 exact-action score from16 to17; both checkpoints are immutable.

The full679 result is **not ready for live promotion**. Exact actions increased18 to99, but all net gain came from camera moves (0 to81); non-camera exact actions remain18. Probe production remains1/39, gas actions fell4/4 to1/4, and original opening anchors fell17/24 to14/24. Unweighted per-function mean exact-action accuracy fell37.95% to32.87%. The next learning repair is camera/production balance and retention, not repeating the same epoch unchanged. These are one-PvT-TRAIN-replay diagnostics, not held-out skill, Hard-AI wins or MMR. [Evidence](runs/heartbeat-20260926-0207/learning-summary.json).

The already saved full replay has also been exported into a separate immutable1,217-intent derivative. The old128-entity/16-source model cannot admit most later combat; a CPU-only larger-shape audit observes236 entities/18 selected units and supports1,202 examples. Graph/optimizer migration and the remaining EnergyRecharge, WarpGate and cooldown semantics are not verified. This derivative is not active training data. [Next implementation gates](runs/heartbeat-20260926-0207/NEXT_GATES.md).

SC2TOOLS mapping is still active: **104/620 complete local native captures, 516 pending**, checked2026-09-26T02:38:43.071018+00:00. The original agent PID/creation time matches and one SC2 capture child is active. The three prior oversized uploads remain recovered. A fourth, long Lockdown replay retains its complete local cache but exceeds both the corrected5MiB request and200,000-motion-point limits; one shot/death timestamp also needs semantic review. Do not recapture it or truncate its events. [Failure evidence](runs/heartbeat-20260926-0207/upload-recovery/README.md). The installed source fix does not hot-update the running packaged EXE.

New fitter/preflight tests:25 passed; Ruff passed; both actual GPU runs and independent reloads completed. The previous2,905-test full-suite receipt remains historical. No new game was launched: league stays81 committed games (P49/T16/Z16),84 snapshots and18 STOPs unchanged. All90 original replays and the72/18 whole-replay split are preserved. Keep exactly eight workers, Protoss200APM with actual camera/selection/fog, separate fog-obeying600APM Terran/Zerg policies, TRAIN-only2x user-loss opponent weighting, and unweighted evaluation. Never feed spectator mapping into actor observations. Check process identity before another job.

## Historical status before the balanced fitting repair

## Active replay mapping and richer imitation connection â€” September 25, 2026

The user explicitly authorized enabling full SC2TOOLS replay mapping. Automatic capture is enabled in the existing paired agent. All 620 verified eight-worker originals are handled: 615 accepted requests plus five reused complete caches. At 22:26 UTC, 25 captures were complete and 595 remained pending; the original agent continues mapping and the dispatcher has exited. See [REPLAY_MAPPING.md](REPLAY_MAPPING.md), `TRAINING_ACTIVE.json.sc2tools_mapping`, and `runs/replay-expansion-inventory-v1/progress-current.json` for dispatch versus capture completion. Do not start another SC2 engine while the agent owns capture.

The old 90-game corpus, league checkpoints and STOP markers remain unchanged. `runs/alphastar-intent-dataset-v1` now contains 681 causal command/camera training examples including the missing gas/Core/Nexus instructions. The real-data AlphaStar bridge completed 64 TRAIN-only updates and an exact checkpoint reload. Observation-only inference now restores all 422 parameter leaves and produces real predictions without expert labels. In its 24-frame greedy check it predicted Assimilator every time (4 correct functions, 0 complete exact actions). This tiny checkpoint remains unsuitable for native deployment. The paid UI runtime and prediction binding have separate checks; native execution and held-out generalization remain unverified. The separate 620-original/1,240-perspective expansion plan preserves all original whole-replay holdouts; it is not yet an active training corpus. Spectator mapping must never become hidden actor input.

# Ongoing Protoss training

Current status, 25 September 2026: **SC2TOOLS replay mapping is running; the old league remains stopped at its execution review gate.** The official AlphaStar bridge has completed 64 real-replay TRAIN-only optimizer updates on 24 selected events and verified exact checkpoint restoration. This is a tiny pipeline diagnostic, not a competitive policy or a held-out evaluation. The restricted prediction decoder is implemented. The observation-only GPU inference connection is now verified. Bounded imitation fitting must improve the constant-Assimilator predictions before native execution verification. See [the foundation](ALPHASTAR_FOUNDATION.md) and [saved training result](runs/alphastar-foundation-v1/replay-gradient-v3/result.json).

Coached **v22 completed a six-minute Hard-Terran opening diagnostic**, recorded as a time-limit Tie. First Stalker improved by 33.57 seconds, second Chrono by 161.79 seconds, and optional spending before the first Stalker was eliminated. Core foundation and Probe restart timing were unchanged. It reached 44 workers and 20 army supply, with 389 inputs and a peak of 99 per rolling minute. The first Stalker and Sentry reached the natural. This is specific repair evidence, not a Hard win, uninterrupted worker-production proof or general placement proof. At cutoff the bank was 90 minerals and 924 gas; resource allocation and later build/army behavior still need work. [Opening comparison](runs/coach-protoss-pilot-v22/opening-comparison.json). V21's failed session/STOP and v20's separately adjudicated Easy win remain preserved.

**Next step:** continue bounded TRAIN-only fitting after reviewing [the observation-only inference diagnostic](runs/alphastar-foundation-v1/inference-gpu-v1/summary.json). All 24 greedy predictions chose Assimilator; this is not a playable opening. No expert action entered the network. The observation-only encoder exactly matches all 679 supported training rows and a native-protobuf frame-to-pointer binding test passes. Add the native inference host and verify paid opening execution only after useful decision/argument accuracy and engine availability. Preserve whole-replay holdouts, actual camera/fog/selection, 200 APM and every STOP. Never feed omniscient SC2TOOLS playback into actor observations. One complete local mapping exceeded cloud upload capacity; reuse its cache after a format correction instead of recapturing it.

Full suite: 2,876 passed in 40.10 seconds. An initial run had one transient local HTTP Win10053; all 43 lobby tests and the full recheck passed. Evidence is in runs/heartbeat-20260925-2206. No model weights changed in this heartbeat. Use fresh short workspace --basetemp paths. Older paragraphs below are historical.

Native control-group fixture v2 passed: two Probes completed while both Nexuses stayed off-screen, and a recalled army moved to its confirmed target. Peak was 42 inputs per rolling minute. Coached v16 completed a Tie at899.64 seconds with142 peak inputs and zero friendly-fire recovery Stops. V17 failed around151 seconds on reserved ability4135; its improved opening inputs and failed-run limits are preserved in its review. That compatibility error now has native-unit regression tests. Partial action audits are preserved on future failures without claiming completed verification.

All coached inputs remain under200APM, camera/fog/selection restrictions and exactly eight starting workers. These changes do not alter neural action dimensions, saved models or the verified replay corpus. League progress remains81 committed games (P49/T16/Z16) pending the current verified resume gate; MMR is unmeasured. Read TRAINING_ACTIVE.json and process creation times before launching any job. Older status below is historical.

The target is a Protoss policy competitive around 6000 MMR in **each** of PvT, PvP and PvZ. Its current rating is **unmeasured**. Standard computer difficulty, teacher demonstrations, imitation accuracy and league wins are not Battle.net MMR. The earlier 24-replay model recorded no wins in its limited computer evaluation.

The user approved recurring progress checks every two hours. The active app automation `continue-protoss-learning-league` inspects the current jobs, investigates failures, and continues authorized local work. It respects STOP markers, avoids duplicate jobs, and reports meaningful progress or blockers.

## Fixed experiment rules

| Player | Starting workers | Input budget | Observation and control |
|---|---:|---:|---|
| Main Protoss and its PvP snapshots | 8 | At most 200 inputs per rolling game minute | Original human camera/selection/spatial-command contract |
| Terran training opponent | 8 | Configurable; currently 600 inputs per rolling game minute | Own units across the map; currently visible, detectable enemies; no camera restriction |
| Zerg training opponent | 8 | Configurable; currently 600 inputs per rolling game minute | Same opponent privileges as Terran |

All sides obey fog and ordinary game resources. The user expanded Protoss human input mechanics to include real F2 and control groups; eight workers, fog, visible tactical targets and the 200-input budget remain required. These are structured game observations, not RGB vision. A larger opponent APM allowance permits extra actions; a build teacher does not automatically use all of it.

## Replay corpus and loss emphasis

`runs/response-90-manifest.json` identifies 90 SHA-verified original ReSpOnSe replays: 30 each PvT/PvP/PvZ, with 15 wins and 15 losses per matchup. All start both players with eight workers on Base97563. Total recorded play is 14.714 actual Faster-game hours.

Protoss imitation uses its own reconstructed, camera-restricted observations. Whole replay games are split by matchup and original outcome: 24 training and six held out in each matchup, including three wins and three losses in every held-out group. Sample weighting balances the matchups; gameplay commands have three times the loss weight of camera/idle labels. A fresh initialization prevents earlier training from leaking into the new held-out split.

Terran and Zerg use the corresponding opponents' build intentions from the same original games. A build that beat ReSpOnSe receives **twice the training-sampling probability** of a build ReSpOnSe defeated. This weight is configurable and applies once when selecting an opponent build. It does not add weight to imitating ReSpOnSe's losing Protoss decisions. Held-out build evaluation is unweighted.

`opponent_builds.py` records original command times, player identity, outcome, decoder provenance and tracker evidence. Construction-init correspondence can remove repeated building clicks. Production/research/morph commands can remain unconfirmed intentions: tracker completion alone does not prove which queued click caused an output. The live teacher accepts only currently legal actions, checks the engine result, and reports omitted/unavailable orders. Its economic fallbacks assign idle workers, fill gas, inject larvae and call MULEs. This is an approximate opening bootstrap, not exact recreation of every opponent decision.

## Separate learners and frozen opponents

`adversary.py` supplies separate Terran and Zerg schemas and adapters. `bootstrap.py` collects legal opening demonstrations in the actual game, fits each race's model and selects the best checkpoint against held-out original replay IDs. A teacher episode cannot enter PPO. The teachers are removed during reinforcement learning.

`league.py` keeps independent weights and Adam optimizers. The five-game update schedule is Protoss versus Terran, Terran versus Protoss, Protoss versus Protoss, Protoss versus Zerg, Zerg versus Protoss. Only the designated learner updates from its own trajectory. Opponents stay frozen during a game. Opponent selection uses the newest available snapshot 70% of the time, and retains older versions for the remaining selection probability when history exists.

Optional standard-AI practice alternates with league rounds for the main Protoss policy. This gives the main policy an additional opponent source while the new T/Z agents learn. Standard evaluation remains separate from asymmetric league results.

The current opponents expose foundational economy, production, upgrades and combat actions. Transport operations and some advanced caster abilities are not yet exposed. Models trained with these adapters are development candidates, not validated master-level agents.

## Running and stopping

Run commands from this workspace with its Python environments. `.venv` is the CPU/game runtime. `.venv-gpu` contains CUDA PyTorch for batched imitation on the RTX 4090. Current local benchmarks favor four CPU threads for individual decisions and PPO.

Create a league after obtaining all three actual imitation checkpoints:

```powershell
.venv/Scripts/python.exe -m pluto_sc2.league init --output runs/response-league --protoss PATH_TO_PROTOSS.pt --terran PATH_TO_TERRAN.pt --zerg PATH_TO_ZERG.pt --adversary-apm 600 --builtin-practice
.venv/Scripts/python.exe -m pluto_sc2.league_supervisor init --output runs/response-league-monitor --league runs/response-league --maps maps/SanctuaryIIILE.SC2Map maps/TourmalineLE.SC2Map maps/BlackrockLE.SC2Map maps/RainfallLE.SC2Map
.venv/Scripts/python.exe -m pluto_sc2.league_supervisor run --output runs/response-league-monitor
```

These commands are recipes; see `TRAINING_ACTIVE.json` for paths and phases actually started. Omitting T/Z checkpoints explicitly creates random opponents and does not count as replay bootstrapping.

Preparation is complete: the replay corpus and imitation checkpoints are available, and each adversary completed twelve weighted training openings and six unweighted held-out openings. Do not rerun `scripts/continue_training.py` to resume this existing league. Resume its supervisor directly with `league_supervisor run --output runs/response-league-monitor` only after checking for an active job and persistent STOP markers. The direct supervisor was restarted after the runtime checks below; verify its current PID and creation time in `TRAINING_ACTIVE.json` and the supervisor manifest.

To stop all configured training phases gracefully after their current games:

```powershell
.venv/Scripts/python.exe scripts/stop_training.py
```

This writes persistent markers for both collectors, the pipeline and the league. Removing these markers is an explicit resume decision.

```powershell
.venv/Scripts/python.exe -m pluto_sc2.league_supervisor status --output runs/response-league-monitor
.venv/Scripts/python.exe -m pluto_sc2.league_supervisor stop --output runs/response-league-monitor
```

The STOP marker takes effect between games. It persists and must not be removed by a monitoring agent. Duplicate supervisors are locked out. Child game jobs are time bounded; cleanup targets only their own child processes. Each immutable checkpoint and the atomic league manifest form a transaction, so an interrupted update cannot be applied twice.

Every 30 committed league games, the supervisor evaluates the same frozen Protoss checkpoint in three games per matchup. Separate curriculum levels advance only after two successive evaluation cycles with all three actual wins; timeout ties do not count. This is a curriculum rule, not a statistically calibrated strength or MMR estimate. Six evaluation cycles without improvement or low disk space require inspection before continued identical training.

The ladder region has not been specified. No paid compute or Battle.net ranked automation has been configured. Demonstrating proximity to 6000 requires independent, current and region-specific evidence against appropriately rated human opposition in each matchup.

## Runtime corrections activated September 25

Protoss's `scout` action can designate only one Probe per game. The designation begins after the spatial move command is accepted, survives that Probe's death, and prevents repeated scout choices from sending replacement workers out of the mineral line. The designated Probe can be reused when visible; Observers and Warp Prisms remain available as scouts. Selection failures do not designate a worker. These controls neither send a scout automatically nor return one to mining automatically.

Protoss resigns when its own HUD shows zero workers and fewer minerals than the public Probe cost (50), and permitted observations establish no pending Probe or possible refundable work. Accepted command history, visible queues and known unfinished assets protect uncertain recovery paths. An off-screen pending queue never expires merely because time passes. A justified resignation calls the actual SC2 leave operation and records terminal defeat and its evidence; it is not a time-limit tie. Externally interrupted matches remain incomplete and must not be turned into training wins.

Terran and Zerg commit to an accepted strategic army order for five game seconds. Currently observed combat pressure permits a relevant defensive, retreat or visible-target response after one game second. Redundant matching orders are masked. Attack objectives can use the remembered positions of previously observed enemy buildings; memory is removed when the position is visibly empty, without consulting hidden enemy state.

Opponent townhall placement uses public resource-cluster expansion geometry, excludes existing bases and requires a currently visible legal footprint. Other building placement searches a wider area while avoiding known structures, resource access, observed rally lanes and Terran addon space. The policy still chooses which building to attempt; these helpers resolve a legal location rather than supply a build order.

Each policy decision now reuses the critic value returned by its action forward pass to close the previous transition. This removes a duplicate inference on the same observation without changing game-step sizes, observation history, discounting or input limits. These are runtime and action-control corrections, not evidence of learned strength. Record their actual activation and verify new match artifacts before comparing outcomes.

The direct supervisor resumed from 80 committed games after three 180-second live adapter/PPO checks and two consecutive injected-concession games passed. The latter verified actual Defeat/Victory results, terminal loss reward and next-game startup; the economic resignation condition has separate regression tests. See `runs/control-fixes-verification/verification.json` and `runs/forfeit-transport-verification/verification.json`. The old pipeline process is historical; current process identity is recorded in `TRAINING_ACTIVE.json` and the supervisor manifest.

## Dense rewards and active guidance

See [REWARDS.md](REWARDS.md) for the `tactical-economy-v1` economy, production, scouting, combat and replay-progress profile. Its activation file is `runs/response-league/reward-config.json`; the league reads it at each new game. Current-game weights and reward rules stay fixed. `viewer.json` records the running profile and reference ID, and committed `match.json` records the reward breakdown and complete selected reference. The winning replay target artifact is hash-pinned and never changes during a rollout.

At each recurring check, run `.venv/Scripts/python.exe scripts/training_reward_report.py --league runs/response-league` alongside the process/checkpoint checks. Compare completed production, mining, scouting and combat signals across committed games and reward versions. Keep formal frozen-checkpoint evaluation unweighted and separate. A reward increase without improved production, combat or wins is not evidence of strength. Diagnose bottlenecks before tuning, test changes, preserve snapshots and activate only at game boundaries.

## Resume validation — September 25

The coached executor now preserves a short-lived defense alert from enemies
actually seen near a known base, visits remembered army positions, and sends
currently selectable combat groups to that threatened base. Gas-camera visits
frame legal construction footprints, then return to production. Pending build
sites receive paced revisits even after a base disappears. Reserved 4135 orders
are preserved as unknown/busy, preventing a Burnysc2 parsing crash without
commandeering gas workers or reserved builders. Coached runs remain separate
from model training.

Pilot v5 completed 600seconds:8 starting workers,44 workers / 49 army supply in its
last HUD, two Assimilators, two accepted strategies and peak 77 rolling inputs.
It ended at the configured time limit against VeryEasy. This is execution
validation, not a win or rating. The full suite passed1003 tests; Ruff passed.

The supervisor resumed with process/socket diagnostics and a two-second delay on
addons after observed Terran production-building landings. The three rejected
diagnostics had alive engines and closed sockets during Factory Tech Lab
commands; the root cause remains unconfirmed. See the current validation
artifact and handoff before any further restart or control change.
