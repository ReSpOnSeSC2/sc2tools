# Coached opponents in the learning league

The candidate integration plays frozen, replay-informed Protoss build plans against a neural learner. It does not make live Codex decisions or give the coached side an optimizer. The ordinary coached executor still uses exactly eight starting workers, a hard 200-input rolling-minute limit, camera and spatial selection restrictions, and fog.

`runs/training-resume-20260925-coached/coach-opponent.candidate.json` pins the opening library, strategy library and full-replay review sources. The four currently supported plans have 19 phases across PvT, PvP and PvZ. Missing advanced control and exact PvZ wall execution are documented in `runs/training-resume-20260925-coached/CURRICULUM_DESIGN.md`; the reviewed plans are approximations, not exact replay reproduction.

Once verified, copying that configuration to `runs/response-league/coach-opponent.json` enables coached opponents in the existing TvP, PvP and ZvP slots every other five-game cycle. Neural opponents remain in the other cycles. Each game captures immutable copies of its selected opening, plan and provenance. Only the designated neural learner supplies PPO transitions. The replay corpus and whole-replay validation split remain unchanged.

The isolated command below uses a saved Terran checkpoint and writes no new model or league state. `--update-in-memory` checks PPO compatibility only. Use a new output directory and verify no SC2 or league job is active before launching.

```powershell
.venv/Scripts/python.exe -u scripts/diagnose_coached_league_match.py --checkpoint runs/response-league/matches/0000077-0e57e58085d4/learner.pt --race Terran --config runs/training-resume-20260925-coached/coach-opponent.candidate.json --output runs/coach-vs-neural-verification-20260925-v1 --map maps/SanctuaryIIILE.SC2Map --seconds 900 --seed 1 --update-in-memory --run
```

During a game, the coach's permitted observations and macro decisions appear in the output's `coach-opponent` directory. Its `STOP` marker requests a normal concession. Preserve all diagnostic artifacts, including failed runs. Passing mechanical checks or beating a neural opponent is not an MMR measurement.

Activation is pending live validation. See `TRAINING_ACTIVE.json` for the current gate and process identity.
