# Moving coached improvements into neural play

## Acceleration assessment, September 25

Recommendation: preserve the existing neural league as a baseline, but make the next learning experiment a strategic student over the corrected coached executor. The student chooses a build/phase, composition, scout mission, expansion decision, stance and observed objective; the executor handles the paid camera, selections, production and movement. This reduces the learning problem without bypassing eight-worker starts, 200 APM, camera restrictions or fog. It is a proposed schema change, not an activated or trained model.

The existing network was pretrained on the user's90 replay corpus, so it is not currently random initialization. The recorded pretraining used72 training replays and18 held-out replays; only5,904 training examples were classified as gameplay commands, versus45,001 total training examples. Its broad action-label objective did not teach precise unit selection/targeting or full tactical plans. The live83-action network cannot directly reproduce several coached commands. Longer training does not fix missing actions or broken execution.

A teacher need not be a neural network. Corrected scripted/coached decisions can supply supervised examples, analogous to fine-tuning on demonstrations: permitted state/history -> desired strategy or executable action. A collector must record the decision-time inputs and actual executed semantics, not just a later report or action name. Filter known stalls, enclosure failures and unintended commands; a won game is not automatically all good labels. Use held-out whole games and original replay/build identities. Correct the student's own encountered mistakes in later rounds, then use RL to improve beyond imitation. Do not fabricate PPO behavior probabilities for teacher commands. Existing coach-vs-neural games make the coach an opponent; they do not implement this teaching path.

Offline minibatch training can reuse collected decisions without playing another full game for every update. Short in-engine opening, defense and combat drills can collect focused experience faster than always restarting a full match. Engine stepping can run faster than real time and independent instances may improve throughput after a local benchmark. Neither replay readers nor a build-order table simulate arbitrary new fights; synthetic scenarios remain separately labeled and full-game evaluation stays necessary. No throughput multiplier or6000MMR completion date is established.

Primary-source options checked September25 (no external model downloaded or installed):

| Resource | Verified offering | Fit for this project |
| --- | --- | --- |
| [AlphaStar](https://github.com/google-deepmind/alphastar) | Architectures, replay data readers, offline training/evaluation; no packaged release on its releases page | Useful design and data pipeline reference; no ready champion checkpoint verified |
| [StarTrain](https://github.com/MichalOp/StarTrain) | Download links for trained Protoss models; feature interface; SC2 4.9.3/Acropolis experiments | Actual pretrained candidate, but older environment and modest published Hard results; current eight-worker/camera/APM compatibility and download integrity unverified |
| [TStarBot-X](https://github.com/tencent-ailab/tleague_projpage/blob/master/tstarbotx/gm_test.md) | Released8/25/33-day neural models; documented runner is ZvZ on KairosJunction, SC2 4.10.0 | Not a compatible Protoss checkpoint; possible research/reference work |
| [Pluto](https://github.com/tscmoo/pluto) | Brood War neural bot, beta binaries and weights | Different game/BWAPI; weights cannot be directly loaded into our SC2 policy |
| [Ares](https://aressc2.github.io/ares-sc2/) / [Sharpy](https://github.com/DrInfy/sharpy-sc2) | Bot frameworks, including build/micro/placement infrastructure | Candidates to adapt tested algorithms into the restricted executor; not pretrained neural policies or proof of strength under our restrictions |

[AlphaStar Unplugged](https://arxiv.org/abs/2308.03526) establishes that substantial SC2 learning can use offline replay data. It does not establish that this small corpus or current architecture will reproduce its result.

The immediate teacher-quality blockers are preserved v21 early spending/Chrono interference and small-unit enclosure. V21 finished Defeat at576.43s; it should not be promoted as a successful teacher. No demonstrations from the coached series have yet trained new weights.

The coached v20 game is recorded as a **win by the Easy Terran opponent's explicit surrender**, confirmed by the user. Its original engine timeout result remains in the immutable session audit; the separate adjudication is `runs/coach-protoss-pilot-v20/adjudication.json`. This is coached progress, not a neural-policy or MMR result.

The next coached opponent is **Hard**, as requested. Neural league progress is still81 committed games (P49/T16/Z16). No checkpoint or replay corpus was changed by this repair work.

## What already transfers

Both bots use the same FairPlay and target-geometry enforcement: real200APM accounting, camera/fog restrictions, safe ground targeting, and actual selection confirmation. Safe order decoding, the single-worker scout lease and economic resignation also exist in neural play. Fixes in these shared paths take effect in newly started games; they do not train network weights.

## What does not transfer automatically

The current Protoss policy has83 categorical actions and2040 observation values. It does not predict a source selection, target coordinate/tag, control-group index or persistent tactical route. CoachBot runs with `record=False`; its reports and action audit are not a ready-made PPO training dataset.

Coached opening/Chrono timing, builder reservations, local escape-aware placement, F2/groups, army cohesion, scouting routes, Prism control and harassment therefore need explicit integration. Some commands have no matching neural action. For example, labeling a scout's return-home move as `scout` would be wrong: the neural adapter currently sends that action toward the enemy start. A `chrono_boost` label alone also cannot teach the new Stalker-producer target when its adapter selects a different building.

## Safe implementation sequence

1. Extract compatible input and construction helpers into a versioned, opt-in neural control profile. Apply legality and opening constraints before policy sampling, then store the same mask and the actual sampled action/log probability. Label this assistance separately from learned performance. Preserve the200APM/fog contract and all eight-worker starts.
2. Add a dedicated coach demonstration collector and validator. Record the preceding permitted observation, exact legal mask, accepted command receipt, target/source semantics, game ID, original build-source ID and source hashes. Keep only commands that the neural adapter can actually reproduce. Do not pretend these are original SC2 replay observations.
3. Train a new checkpoint by masked supervised imitation on those compatible demonstrations. Split by whole game and original build source, retain an unweighted held-out set, and preserve the original corpus and models. Do not invent PPO log probabilities for scripted teacher actions.
4. Resume reinforcement learning from the new candidate against frozen opponents, including the existing optional frozen-coach opponent path. Opponent coaching and learning from demonstrations are distinct mechanisms. Evaluate unassisted and assisted policies separately in PvT, PvP and PvZ.
5. Add richer policy outputs for source groups and tactical targets if we want the network itself to learn the remaining micro and routes. That requires an explicit observation/action schema migration and new evaluation, rather than silently changing what the old83 labels mean.

Passing a coached game, imitation accuracy or beating a built-in difficulty does not establish ladder MMR. Independent matchup-specific evidence is still required for the6000MMR target.
