# Continuous imitation with causal own-player HUD

This experiment predicts raw replay command tokens from the player's previous
commands and stale own HUD values. It is an offline macro prior, not a complete
StarCraft II controller. It does not choose source units, prove building placement,
execute micro, or establish game wins or a ladder rating.

## Data contract

`build_order_imitation_v1.py` consumes only prior own-command tokens and elapsed own
command times. Replay identities, global event ordinals, matchup, outcome and decoded
legacy names are provenance or evaluation metadata, not actor features. Raw command
tokens are not native ability IDs and cannot be sent directly to the game.

The versioned HUD sidecar uses the latest own-player tracker sample **S** strictly
before the previous own-command anchor **A**, which must be strictly before target
command **T**: `S < A < T`. Same-loop target siblings cannot become history. Missing
samples stay missing; no future backfill or opponent statistics are allowed.

The eight static features are normalized own minerals, own gas, Protoss supply used,
sample age at A, three known-value bits and a known-sample bit. Unknown values are
zero with explicit masks; a row with no admitted values encodes as exactly zero.
Supply capacity (`FoodMade`) is not admitted. Tracker banks are stale observations,
not evidence that a command is currently affordable or legal.

The current contract pins 619 original replays with 495 TRAIN and 124 validation
originals. It preserves 1,238 perspective rows, including two empty-command views,
and 152,312 target rows. These are corpus counts, not the model's training subset:
the Protoss HUD experiment uses targets from the first 480 game seconds, with 45,949
unweighted TRAIN examples and 11,807 validation examples. Whole originals stay on one
side of the split. Every training perspective is included per pass; approved opponent
wins receive exactly twice the training exposure. Evaluation remains unweighted.

The current scripts deliberately require these exact receipts and hashes. They are
reproducible experiments, not generic trainers for an arbitrary folder of replays.
A different dataset, timing horizon, protocol, vocabulary or parent model requires a
new versioned contract and fresh independent admission proof.

## Model and continuation

`HudResidualPrior` freezes the selected command-history parent and its optimizer.
A zero-initialized, bias-free linear adapter maps the eight HUD features to command
logit residuals; it has a separate Adam optimizer and age. The base wait prediction
is unchanged. The original vocabulary mask is reapplied after the residual. Missing
HUD produces zero residual even after training, and the initial zero adapter must
exactly reproduce the frozen parent's outputs.

This trainer optimizes only the Protoss HUD residual. Separate Terran and Zerg
command priors remain preserved; this continuation does not optimize them.

The objective is unweighted command cross entropy, without a second outcome/class
weight. Command accuracy is compared with repeat-last behavior, per-matchup/category
results and worker/first-Pylon/first-Gateway/deeper production retention. The validation
set is reused for model selection; it is not an untouched final test set.

Checkpoints preserve adapter parameters, Adam, RNG, shuffle order, cursor, source/data
hashes and the immutable parent. The trainer records PID plus process creation time,
uses a process lease, honors STOP markers and saves the accepted cursor on bounded
exit. Continuous mode is explicit and requires an independently reviewed continuation
receipt. It does not discard failed quality gates or automatically promote a policy.

## Reproduce with the original private inputs

Use a separate, inactive output directory and the original pinned receipts. The CLI
interfaces below show the required inputs; they are not instructions to restart an
already active learner. Paths in existing receipts must still resolve and hash-match.

```text
python scripts/extract_own_hud_features_v1.py --dataset <sequences-directory> --readiness <readiness.json> --output <new-sidecar-directory> --max-seconds 600
python scripts/verify_own_hud_sidecar_v1.py --sidecar <new-sidecar-directory> --output <new-independent-review.json>
python scripts/train_build_order_hud_v1.py --dataset <sequences-directory> --hud-sidecar <admitted-sidecar-directory> --hud-review <pinned-independent-review.json> --parent-run <selected-parent-directory> --baseline-audit <pinned-milestone-audit.json> --output <new-run-directory> --epochs 2 --wall-seconds 600 --threads 2
python scripts/reload_build_order_hud_v1.py --run <run-directory> --output <new-reload-review.json>
```

The current trainer pins the original independent-review bytes. Re-extracting into
different paths produces different provenance and does not automatically satisfy
that pin. Preserve the original proof or implement and review a deliberate migration;
do not rewrite hashes to force admission. `--help` is safe for inspecting each CLI.

`start_continuous_hud_host_v1.ps1` and `resume_continuous_hud_host_v1.py` are preserved
historical host entrypoints with specific run paths, a specific trainer hash and
Windows `pythonw.exe` assumptions. Do not run them on a fresh checkout or archived
copy. Use the trainer's explicit arguments only after verifying the intended run's
process identity, STOPs and continuation contract.

This training uses no SC2 process. It can coexist with website mapping without
claiming that omniscient mapping frames are valid actor inputs. Native gameplay still
requires its own fog/camera/APM, source-selection, placement and engine-ownership
checks, followed by independent matches against the intended opponents.
