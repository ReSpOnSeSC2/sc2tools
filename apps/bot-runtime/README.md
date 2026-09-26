# SC2TOOLS local bot runtime

This package contains the coached executor, independent Protoss/Terran/Zerg
policies, replay imitation pipeline, league training, replay viewer and human
match host. It is development software, not a validated competitive release.
The structured AlphaStar experiment uses published architecture code; no
AlphaStar champion weights are included or claimed.

All engine simulation, inference and training run on the user's own computer.
The website serves a small, default-disabled administrative control surface.
Ordinary website visitors and desktop-agent installs do not load ML libraries.
Checkpoints, maps, original replays, local credentials and training manifests
are deliberately absent from Git and the installer.

## Runtime and local data

Install Python 3.12 and SC2 locally, create a dedicated environment, and install
this package with `python -m pip install -e .`. Development tests use `.[dev]`.
Do not install these dependencies into the desktop agent's Python environment.
Existing local workspaces can retain their environments, immutable checkpoints,
STOP markers and replay splits while using this source package.

The local workspace must contain `TRAINING_ACTIVE.json`, a league manifest with
immutable hash-verified snapshots, and configured modern eight-worker maps.
See [human play](PLAY_AGAINST_BOTS.md), [training](TRAINING.md),
[coaching](COACH.md), [replay mapping](REPLAY_MAPPING.md) and
[the structured observation contract](ALPHASTAR_INPUT_CONTRACT.md).
Historical diagnostic counts in the imported development documents describe
the original local experiment; their private `runs/` artifacts are not shipped.

For a visible immutable neural checkpoint preview, see [live neural play](LIVE_NEURAL.md).

## Hidden website integration

See [the private integration guide](../../docs/bot-lab.md). The desktop agent
bundles only this package's source as an optional asset. Explicit local runtime
configuration and separate API/web administrator gates are required.
Public bot distribution and validated checkpoint promotion remain future work.

## AlphaStar experiment

The offline structured experiment requires a separate Linux/WSL Python 3.10
environment. `requirements/alphastar-linux.lock` pins the tested numerical
environment; it is not the Windows game runtime. The unmodified official
source at commit `700b1e74364ed5dfc66f6cd2574c5ffac2fa474e` is preserved under
`references/alphastar-upstream`, including its Apache-2.0 license. Run
`python scripts/prepare_alphastar_source.py`, then supply
`--upstream references/alphastar-upstream`. The scripts verify the original files and dataset/checkpoint
hashes. The local experiment's default workcopy path is documented in the
scripts; a fresh checkout needs explicit data and runtime setup. Existing
checkpoint continuations must retain their pinned original source paths and
hashes; moving an active run requires a separate reviewed provenance migration.

Opt-in offline eligibility checks are provided by
`scripts/preflight_action_eligibility_v2.py` and
`scripts/audit_alphastar_eligibility_v2.py`. The v2 rules use public producer
compatibility and known mineral/gas costs; supply and selected-panel ability
absence are informational because valid production can be queued. These
audits do not update weights or change the live host. Native queue execution
requires its own verification.

Opt-in experimental building-location repair is available through
`scripts/audit_alphastar_building_placement_v1.py`,
`scripts/fit_alphastar_building_world.py` and
`scripts/reload_alphastar_building_world.py`. Current visible structures and
public footprints can exclude proven overlaps; retained targets are not
certified legal placements. The audit requires a user-provided, hash-pinned
`--placement-preflight` CPU evidence report in addition to the existing local
replay/checkpoint inputs. Those private reports and `runs/` data are not shipped.
The bounded fitter updates only the existing world head and its Adam moments.
Its separate candidate schema is experimental: the shared Adam age advances
while frozen-head moments do not, so resuming ordinary full-model training
requires a separately reviewed optimizer migration. These commands neither
activate the live host nor promote a checkpoint or establish gameplay strength.

Dataset collection preserves whole-replay train/validation separation. Actor
observations must come from the selected player's permitted view, never from
the omniscient website playback recording. Offline fitting can run while
playback mapping continues; native matches wait for the capture engine lease.

Every match starts with eight workers. Protoss retains 200 actual inputs per
rolling game minute, camera/selection rules and fog. Terran and Zerg have
separate policies, 600 APM and global own/current-visible-enemy control with
fog. Weighted training never changes unweighted evaluation or supplies a ladder
MMR. See [third-party provenance](THIRD_PARTY.md).


## Current project and continuous-learning guides

The public implementation stays in this package. The intended private local project
home is `C:/SC2TOOLS/.local/bot-project/workspace`, outside Git and the installer.
See [local project organization](LOCAL_PROJECT_LAYOUT.md) for safe snapshots and why
copying files does not relocate a running learner or its pinned provenance.

[Continuous own-HUD imitation](CONTINUOUS_OWN_HUD.md) documents the frozen command
prior, separately optimized Protoss HUD residual, causal data admission, exact
continuation and evaluation limits. Preserved Terran/Zerg priors are separate;
this continuation does not optimize them. [Reward feedback](REWARD_FEEDBACK.md)
records the gap between live feedback collection and an implemented RL optimizer.
The [structured experiment guide](ALPHASTAR_FOUNDATION.md) distinguishes that work
from the smaller command prior. No game-strength or MMR claim follows from these
source additions. The website and local agent remain separately default-disabled.

Run `python scripts/verify_source_manifest.py` to check controlled source bytes
without loading a model or starting SC2. Private inputs and immutable checkpoints
must satisfy their own original experiment contracts before any training or play.
