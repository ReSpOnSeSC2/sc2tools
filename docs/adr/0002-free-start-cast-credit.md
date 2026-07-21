# ADR 0002: Expected chrono/MULE counts credit starting energy

**Status**: Accepted
**Date**: 2026-07-21
**Context**: Follow-up to ADR 0001 (chrono period fix)

## Summary

`chronos_expected` and `mules_expected` were computed as caster
alive-time divided by the energy-regen cooldown, ignoring that each
Nexus and each Orbital Command finishes with 50 energy banked — exactly
one cast available before any regen. A player who spent that starting
energy (correct play) routinely exceeded the regen-only estimate, so
the SPA showed efficiencies over 100% ("11 of ~8 expected (138%
chronos)"). Fixed by adding one free cast per Nexus/Orbital to the
expected count.

## Context

ADR 0001 fixed the chrono *period* (buff duration 20 s → cast cooldown
~89 s) and even listed the starting-energy fact in its math table:

> | Nexus starting energy | 50 (1 cast immediately available) | LotV+ |

and used it in the realistic-ceiling example ("1140 / 89 ≈ 13 + ~3
free-start chronos = **~16**") — but the decision only changed
`CHRONO_PERIOD_SEC`; `_expected()` stayed `alive_sec // period_sec`.

The consequence is systematic under-expectation by exactly the number
of casters. In the reported game: 11 chronos actually cast against
"~8 expected" from ~3 Nexuses' uptime. The correct expectation is
~8 regen cycles + 3 free-start casts ≈ 11 — the player was on pace,
not 38 % ahead of a physical ceiling.

## Decision

1. `_expected(alive_sec, period_sec, free_casts=0)` adds `free_casts`
   to the regen quotient (still 0 when alive-time is 0).
2. Protoss passes `free_casts = count of Nexuses`; Terran passes
   `free_casts = count of Orbital Commands`. Both casters spawn/morph
   in with 50 energy — one full cast (chrono 50, MULE 50).
3. Zerg is unchanged: injects are cast by Queens, which are not in the
   `bases` list the branch iterates — hatchery uptime is only a proxy
   for queen count, so no per-caster credit is possible. Queens do
   spawn inject-ready (25 energy), but the branch's `grace_cycles=4`
   already absorbs slack of that order.
4. `grace_cycles` stay as calibrated in ADR 0001 (Protoss 2, Terran 2):
   expected counts rise by ~2-4 in typical games, keeping the grace at
   roughly the same 10-20 % slack band.

## Consequences

**Efficiency can no longer exceed 100 % on normal play.** Values above
100 % now genuinely mean banking toward the 200-energy cap and
spending stored casts — rare and small, so left uncapped.

**Scores move slightly down for Protoss and Terran.** Expected counts
rise by the caster count, so the penalty threshold (`expected -
grace`) rises equally. Players already spending starting energy see no
change in penalty (their `actual` includes those casts); players who
let starting energy sit are now — correctly — measured against it. As
with ADR 0001, no DB backfill: the SPA's recompute path rewrites the
breakdown when a game is opened, via the desktop agent's bundled
engine (1.5.5+ / agent 0.15.6+).

## Alternatives considered

* **Cap the displayed percentage at 100 %.** Rejected: hides the
  modeling error instead of fixing it, and would still under-penalize
  players who skip their free casts.
* **Per-caster flooring (`Σ (1 + alive_i // period)`)**. Slightly more
  faithful than flooring the summed alive-time, but the difference is
  at most (casters − 1) cycles and `~` display precision doesn't
  warrant threading per-building math through `_alive_seconds`.
* **Credit Zerg queens via an estimated queen count.** Rejected:
  inventing a queen count from hatchery uptime adds a second layer of
  proxy error; the existing grace already covers it.

## References

* `apps/replay-engine/analytics/macro_score.py` — constants block,
  `_expected`, `_caster_count`, Protoss/Terran branches.
* `apps/replay-engine/tests/test_chrono_targets.py` — free-cast pins.
* ADR 0001 — chrono period fix (this ADR completes its math table).
