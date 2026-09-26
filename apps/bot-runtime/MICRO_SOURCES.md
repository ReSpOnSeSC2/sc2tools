# Micro implementation references

Reviewed September 25, 2026. The coached micro remains a scripted experiment,
not a demonstrated competitive bot or learned micro policy.

- [Ares StutterUnitBack](https://github.com/AresSC2/ares-sc2/blob/main/src/ares/behaviors/combat/individual/stutter_unit_back.py)
  separates firing readiness from movement to safety while reloading.
- [Ares ShootTargetInRange](https://github.com/AresSC2/ares-sc2/blob/main/src/ares/behaviors/combat/individual/shoot_target_in_range.py)
  protects an existing ready attack against a reachable target.
- [Ares influence/pathing documentation](https://aressc2.github.io/ares-sc2/tutorials/influence_and_pathing.html)
  describes danger-weighted movement.
- [Sharpy DefaultMicroMethods](https://github.com/DrInfy/sharpy-sc2/blob/develop/sharpy/combat/default_micro_methods.py)
  includes regrouping and assigned-damage focus-fire logic. These are references
  for further work; we have not ported its full controller or damage accounting.

Ares is [MIT licensed](https://github.com/AresSC2/ares-sc2/blob/main/LICENSE)
(2023 AresSC2); Sharpy is [MIT licensed](https://github.com/DrInfy/sharpy-sc2/blob/develop/LICENSE)
(2019 DrInfy). The local changes are independently written implementations of
these ideas; no upstream source files or new framework dependencies were copied.
Retain upstream notices if code is vendored in future.

## Local adaptation

`coach_combat.py` now compares five short retreat directions using only enemies
currently on screen. A lower estimated exposure is required; visibility is
checked before terrain queries, and a blocked/fogged option can be skipped for
a visible alternative. This estimate does not prove an escape is safe outside
the camera and does not model spell projectiles.

Focus fire excludes distant reinforcements, preserves ready attacks, and uses
a single selection if a same-type control-click would also select protected or
out-of-range units. The existing cooldown kiting, wounded-unit retreat and
Guardian Shield remain. Every command uses the same spatial selection and
200-input rolling-minute budget; camera, fog and eight-worker rules are unchanged.

`coach_army_plan.py` provides front, ranged and support guard positions at a
remembered friendly base. These geometric suggestions require visible terrain
and building-clearance checks when issuing local orders. They are not a
full-map combat simulator and do not establish that a remembered base survives.

Regression tests cover flank threats, distant same-type units, ready attacks,
fog-before-pathing, role spacing and threatened-base selection. Live match
evidence is still needed before claiming the changes improve combat outcomes.

## Support-unit additions after pilot v9

`coach_prism.py` uses a pickup, retreat and unload sequence, also illustrated in
the [Ares cargo maneuver example](https://github.com/AresSC2/ares-sc2/blob/main/docs/tutorials/combat_maneuver_example.md).
The local implementation queries actual abilities and observed capacity, waits
for cargo to appear, protects pickup targets from conflicting micro, and checks
current-screen ground/air threats before unloading. Unknown public pickup range
disables pickup and is reported explicitly. No framework code was copied.

`coach_scout_spells.py` implements Nexus Energy Recharge, Sentry hallucination,
then scouting with the newly observed hallucinated Phoenix. The rules references
are Blizzard's [5.0.14 notes](https://news.blizzard.com/en-gb/article/24162754/starcraft-ii-5-0-14-patch-notes)
and [5.0.15 notes](https://news.blizzard.com/en-us/article/24225313/starcraft-ii-5-0-15-patch-notes).
Current engine ability queries determine affordability and cooldown availability.
Confirmed commands, observed births and actual scout sightings remain separate;
hallucinations do not count toward real army production quotas.

Pilot v9 ended in Defeat after a coached surrender. Its peak was 94 inputs per
rolling game minute. At five minutes it had 36 workers and 12 army supply, versus
25 and 6 in v8. It still lost the expansion and failed to keep fights in view.
The support controllers and shared-army waypoint changes were developed after
v9; that replay is not evidence they work in a live game.

Guardian Shield now requires an observed nearby friendly group actually within
range of multiple ranged threats. It avoids overlapping observed auras, can
cover an ordered retreat, and records confirmed casts separately from selection
attempts. Emergency Prism handling runs first, then Shield, Force Fields, and
ordinary combat micro, so repeated attack orders cannot starve Sentry spells.

`coach_forcefields.py` implements a conservative defensive barrier inspired by
[Sharpy MicroSentries](https://github.com/DrInfy/sharpy-sc2/blob/develop/sharpy/combat/protoss/micro_sentries.py).
It requires a fully observed narrow passage, ranged allies behind the proposed
field and melee threats beyond it. It refuses placements near friendly ground
units, across observed movement routes, or near massive ground units; confirmed
recent targets prevent immediate repeat fields. Geometry checks are local
heuristics, not a guarantee of sealing a passage. Offensive encirclement and
multi-field walls are not implemented. Unknown engine cast range disables the
controller with an explicit diagnostic. The implementation is independently
written and retains the same spatial-input, camera and fog restrictions.
