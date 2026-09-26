# AlphaStar supervised input contract

Implementation contract, 2026-09-25. The typed causal dataset, official standard-lite bridge, 64 real-data diagnostic updates, paid intent decoder and observation-only checkpoint inference are implemented. Better fitted decisions and verified native execution are the next gates. The user has authorized this local continuation; no artifact here establishes competitive strength.

## What is already verified

Official upstream commit: `700b1e74364ed5dfc66f6cd2574c5ffac2fa474e`, Apache-2.0. Its standard-lite encoders, Transformer torso, seven autoregressive heads and supervised loss have completed a GPU forward/backward check. The initial check used the upstream synthetic fixture: 10 entity rows, 11 functions, zero optimizer updates and no replay samples. It proved runtime compatibility. The subsequent real-data bridge and saved checkpoint are described below; neither check establishes playing ability. See [recorded GPU check](runs/alphastar-foundation-v1/runtime-setup/smoke-result-v2.json).

The released standard v3 uses previous-action state and recurrence across the selected-unit list; it does **not** contain the original AlphaStar temporal LSTM. Adding temporal memory would be a separately identified extension. Upstream supplies offline behavior cloning, not an online league trainer or a ready current-patch champion. See [standard construction](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/standard/standard.py), [previous-action handling](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/components/common.py), and [README](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/README.md).

## Admission and causal sample

Use an immutable, fully captured TRAIN replay whose identity, map, engine build/data version, eight-worker start, observed player and whole-replay split are verified. A short capture marked `eligible_for_training: false` remains a fidelity diagnostic. Derivatives get their own manifest with source hashes, vocabulary/configuration hashes and all exclusion counts; never rewrite the capture or existing league corpus.

For each native Action, select the latest observation **strictly before** its game loop. Preserve action order, native wire, exact arguments and timestamps. A correlated raw/feature pair is two views of one Action, not two demonstrations. Unknown, conflicting, friendly-attack, fog-invalid and unresolved targeting records remain in the audit. `supervision.trainable` is necessary but does not establish compatibility with a particular network or decoder. See [capture and causal pairing](src/pluto_sc2/rich_replays.py) and [action serializer/validator](src/pluto_sc2/rich_actions.py).

Proposed derivative record:

```text
replay_id, observed_player, action_ordinal, action_wire_sha256,
preceding_loop, action_loop, observation, tag_to_row,
behaviour_features.action, argument_loss_mask,
previous_admitted_action, admission_reasons, decoder_requirements
```

Use real episode boundaries and a genuine preceding context frame; do not mark every first-action sample FIRST, which upstream intentionally excludes from loss. Intermediate native UI events still update the causal selection/group context. Excluded commands must remain explicit gaps; do not invent previous-action labels or treat a long gap as an uninterrupted expert opening.

## Observation mapping

| Official input | Permitted source and required conversion |
|---|---|
| `game_loop`, `player` | Native loop and named HUD fields. Derive the exact player-vector order from the pinned converter/spec; do not concatenate dictionary values. |
| Race, upgrades, `mmr` | Own/publicly known race information and own upgrades; explicit compact upgrade table. Unknown opponent race stays unknown until legitimately known. MMR conditioning must be known or an explicitly documented unknown setting; the upstream example's `6000` is not a measured rating. |
| `raw_units` and unit counts | Current permitted `entities`, converted to the pinned `FeatureUnit` layout and compact type/buff/order vocabulary. Keep 64-bit tags in a side table; network pointers use bounded row indices. Counts must reflect declared permitted sightings, never freshly enumerated offscreen units. |
| Seven `minimap_*` planes | Decode recorded native feature-layer dimensions, bit depth and bytes: height, visibility, creep, player-relative, alerts, pathable, buildable. Preserve categorical meanings and explicit resampling transforms. Current 64×64 input is not the upstream 128×128 default; either configure 64 or document nearest-neighbor upsampling without claiming added information. |
| `camera` | Construct the world-grid camera footprint from actual map dimensions, camera center and recorded 24×13.5 viewport. Never substitute upstream's larger virtual camera. Retain exact screen/minimap coordinates outside the tensor for decoding and validation. |
| Selection, UI and memory | Retain actual selected tags, `selection_complete`, panels, public current abilities and known-own timestamps as causal context. Stock encoders do not consume all these fields: an explicit selection/knownness embedding is an adapter extension, not an existing stock feature. |

The current capture deliberately omits enemy orders/cargo and fresh offscreen state. It also lacks several fields used by the stock unit encoder, including some power, cargo, resource and upgrade-level attributes. **Do not pretend missing values are observed zero.** Before fitting, enumerate every consumed column: map an actual permitted observation, capture an additional permitted field in a new schema, or explicitly disable that encoder contribution and document the ablation. Historical `known_own` positions are memory, not fresh `raw_units`; defer offscreen-producer training until a typed memory/selection adapter represents that distinction. Zero padding applies only to absent rows.

Exact upstream contracts: [encoders](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/standard/encoders.py), [unit feature consumption and masks](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/components/units.py), [camera plane](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/components/visual.py), [converter defaults](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/unplugged/configs/alphastar_supervised_converter_settings.pbtxt).

## Action vocabulary and actual controls

The smallest bridge learns **command and camera intents**, retaining exact native UI actions for context/audit. It does not claim to imitate every human click yet.

| Head | Label mapping and execution obligation |
|---|---|
| `function` | Resolve native ability ID plus target kind to a pinned PySC2 RAW_FUNCTION ID using current public engine metadata and explicit remaps. Never equate native ability IDs with function indices or assign arbitrary contiguous IDs: upstream argument masks and order tables depend on the RAW_FUNCTION ordering. Unsupported patch functions stay excluded until the registry and dependent masks/tables are deliberately extended. |
| `unit_tags` | Pointer sequence to permitted own source rows, with upstream stop/padding semantics. This expresses which units should act; the runtime must select them through real point/rectangle/F2/registered-group inputs as authorized, then confirm the actual selection. |
| `target_unit_tag` | Pointer to the same observation's valid target row. Friendly production/buff targets are ability-specific; own-unit attack demonstrations are excluded. Runtime rechecks identity, visibility, ability and selection. |
| `world` | Quantize a proven native world target or camera destination using actual map dimensions and the pinned world-grid transform. Keep exact feature coordinates and test round trips. Runtime converts the intent into a permitted camera or screen click, including the existing empty-ground attack guard. |
| `queued` | Preserve the native queue flag; the executor must preserve it or reject unsupported queued execution. |
| `delay`, `repeat` | Version and verify the converter's units, bins and repeat semantics. Preserve exact event intervals as evidence; do not silently clip simultaneous events or long gaps. Disable repeat loss/inference for the first pilot until proved. Expert timing does not waive input pacing. |

No stock head represents a rectangle's two corners, group store/append/recall index, portrait selection, or F2 as a separate UI action. Full UI imitation requires explicit function/argument heads and causal selected/group state, with matching masks and loss tests. Do not encode those events as fake no-ops or fake command demonstrations. See [heads](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/standard/heads.py) and [RAW_FUNCTION-dependent masks](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/architectures/components/util.py).

**RAW_FUNCTION labels are a training representation, not permission to execute raw commands.** Decode through `FairPlayController`: paid camera/selection/command sequence, 200 APM, fog, current-screen target safety, worker/scout protection, and only the authorized registered-production/F2 exceptions. Reobserve after selection or camera movement; rejected or changed intents are logged separately. The upstream camera masks alone do not enforce these project rules. Do not fabricate PPO log probabilities for controller interventions.

## Smallest implementation and gates

1. **Pure importer and vocabulary manifest:** one complete TRAIN replay, initially its opening through first Stalker. Build typed arrays and tag-pointer round trips; inventory coverage for Probe, Pylon, Gateway, gas, Nexus, Core, Chrono and camera. Unknown functions/fields or missing map geometry block the affected labels. Report unsupported opening dependencies rather than hiding them behind overall accuracy.
2. **Real-data GPU integration:** feed small `StreamDict` batches to the official lite network and official supervised loss; a direct reader can avoid the full Beam/TFRecord pipeline initially. Validate every dtype, shape, row permutation, previous-action state and argument mask. Require finite nonzero gradients and zero wrongly masked admitted expert arguments. Upstream otherwise gives masked targets zero loss, which can conceal bad mappings. See [input spec](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/unplugged/data/util.py) and [supervised loss](https://github.com/google-deepmind/alphastar/blob/700b1e74364ed5dfc66f6cd2574c5ffac2fa474e/alphastar/unplugged/losses/supervised.py).
3. **Bounded opening memorization diagnostic:** after the preceding implementation checks pass, fit a fixed small TRAIN set with recorded update/time limits. Report per-argument accuracy, source/target identity, timing and building-position error. Success shows the pipeline can learn an opening; it is not held-out generalization. Keep whole-replay validation unweighted and separate.
4. **Decoder and live opening gate:** first verify replay intent → paid UI plan offline, then an isolated eight-worker game after checking process identities and STOP markers. Require actual observed production/construction through the opening, no friendly attacks, audited restrictions, and explicit accounting for interventions. If the student's changed state makes a teacher target impossible, fail/replan safely rather than copying stale coordinates. Only then broaden to several openings and each matchup; full-game RL is unnecessary to discover a broken input contract. The user's existing continuation authorization applies; these are engineering checks, not a new permission requirement.

The implemented bridge now has an immutable real-data checkpoint after 64 TRAIN-only updates: `runs/alphastar-foundation-v1/replay-gradient-v3`. All 24 selected examples passed active argument/pointer mask checks and the saved checkpoint reloaded exactly. Gas/Core/Nexus are represented as intentions with paid decoder requirements. Knownness and memory age are explicit adapters; race/MMR/upgrades/previous-action encoders and delay/repeat supervision remain ablated in this diagnostic. Position loss and parameter gradients are active, but top-choice positioning did not improve in this small run. These artifacts do not establish successful native opening reproduction, held-out generalization or ladder MMR. See [REPLAY_MAPPING.md](REPLAY_MAPPING.md) for the larger mapping batch and separate inactive whole-replay expansion plan.
