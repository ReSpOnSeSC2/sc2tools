# Neural reward feedback: implementation boundary

`src/pluto_sc2/neural_reward_feedback_v1.py` is an opt-in adapter for the restricted
live neural host. It records observation-derived reward changes under the existing
200-APM camera, selection and fog contract. It does not train a model, launch a game,
or enable the website feature.

Reward events are separate feedback records, never extra actor inputs. The adapter
binds each record to the game session, checkpoint and current permitted observation.
It does not award reward merely because a command was attempted or count arbitrary
global enemy state as observed damage.

The existing reward collector covers economy, production, combat and scouting signals
subject to its visibility and accounting rules. A terminal callback alone is not a
fully accepted training outcome: the adapter marks receipts provisional until host
integrity, paid-input and independent result checks pass. A transport/model failure
is not fabricated as an earned loss, and a time limit is distinct from victory.

The own-HUD and replay command-prior trainers are supervised imitation experiments.
They do not consume these live reward records and must not call offline command
accuracy a win rate. Connecting reward feedback to reinforcement learning requires
verified trajectories, behavior-policy log probabilities/values, correct action and
terminal credit assignment, and a separately reviewed optimizer path. None is
implied by publishing the recording adapter.

The long-term goals remain eight-worker starts and separate PvT/PvP/PvZ evidence.
Protoss retains the hard 200-APM and human-view restrictions; adversary race policies
retain their separate budgets and fog limits. Beating a built-in difficulty, a
self-play opponent, or an imitation metric does not establish ladder MMR.
