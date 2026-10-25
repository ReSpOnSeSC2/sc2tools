# PvZ air opening deadline correction

The requested released PvZ air opening deadline is 7:00 for 2-Stargate
Void Ray and both 2- and 3-Stargate Phoenix labels. All required Stargates,
two Nexuses and four real units must exist by 420 seconds or the first
real Carrier/Tempest, whichever is earlier. The endpoint is inclusive;
events after it cannot qualify, including fractional-second inputs.

The existing ordering and transition rules remain: Stargate is first tech,
hallucinations do not count, early capitals take precedence, established
air openings survive later capitals, Glaives-first reroutes, the Void Ray
Robo guard is 6:00 and the Phoenix Robo guard is 10:00. Those Robo guards
describe tech transitions, separately from the air commitment deadline.

The canonical and importer own-build entry points share the same tree.
These detailed Protoss labels are released on the `you` surface; the
generic opponent Protoss tree is unchanged. Generated API preset catalog
and web definitions are regenerated from the Python sources. Explicit
custom builds and administrator preset replacements retain their authored
criteria. No stored replays are reanalyzed and no live policy is changed.

Validation covers all required-event boundaries at 419, 420, 420.01, 421
and 600 seconds, both Phoenix Stargate counts, late third Stargates,
capital transitions and existing early/late Robo behavior. Full engine,
catalog drift, web consumer and required browser bundle results are
recorded with the final PR evidence.
