# Structured AlphaStar-inspired experiment

This package preserves official AlphaStar architecture source and its license under
`references/alphastar-upstream`. The dependency and upstream source manifests live
under `requirements/`. No champion checkpoint is supplied. The Windows game host and
the separate Linux/WSL numerical experiment use different environments.

The structured policy represents observations and action arguments, including source
selection, unit targets, world targets and camera actions. Native replay observations
must come from the selected player's permitted view. Website spectator recordings
cannot substitute for them. Tensorization, action masks, checkpoint shape migration
and independent inference reload each have versioned proofs and tests.

Source reuse does not make an older action vocabulary or spatial convention compatible
with a modern/custom game patch. Public unit/ability metadata, exact map/start rules,
camera and selection cost, fog and current command legality must be checked at the
native boundary. An accurate replay coordinate also does not prove legal building
placement; conservative observed-overlap rejection is a separate check.

The build-order and own-HUD priors are smaller offline experiments with different
input/output contracts. They are not interchangeable with the structured live policy.
Their raw replay command tokens do not supply native source or placement arguments.
See [the input contract](ALPHASTAR_INPUT_CONTRACT.md),
[live neural host](LIVE_NEURAL.md), and
[own-HUD continuation](CONTINUOUS_OWN_HUD.md).

Private datasets, preflight reports, source snapshots and checkpoints are required to
reproduce an existing experiment. The published scripts preserve strict hash checks;
new inputs or moved paths need an explicit reviewed migration rather than bypassing
those checks. Use independent unweighted evaluations and native-game evidence before
promoting any candidate. Source publication alone makes no competitive-strength claim.
