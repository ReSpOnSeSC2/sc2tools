# ADR0051: Recorded SC2 moments on the existing alert path

Status: Accepted

Moment alerts run once after a newly inserted, freshly ended competitive game
reaches the existing post-ingest overlay fanout. Historical imports, resumed
replays, hidden/deleted rows and repeat ingestions do not produce alerts. A
conditional receipt on the existing owner/game row deduplicates processing;
no new collection, index, background poll or upstream provider call is added.
Owner mutation leases and exact token write admission protect the claim and
delivery from erasure/visibility controls and token rotation.

One bounded slim history read supplies recorded context. Comparative ladder
facts use the exact owner account and ladder race, with the same region guard
as ticker facts. A cached regional season boundary and complete time coverage
are required for a season-peak claim. Missing or truncated evidence suppresses
the claim rather than inventing a baseline. Replay MMR is a game-start rating,
so copy says **Recorded MMR** and never attributes that rating change to the
current game's win. Giant-killer comparisons require replay rating provenance
on both players. Estimated MMR-derived leagues never establish a promotion;
the first actual Pulse league snapshot is only a baseline.

Nine known moment kinds share a closed preference shape under the existing
multichat alert settings. All are opt-in, silent and without bot posts by
default. MMR milestone spacing is exactly100 or250. Visuals and sounds reuse
the existing allowlisted catalogs. Settings use the existing dirty draft/Save
flow; a local Test does not save, enable an integration or post a message.

`overlay:moment` is carried by the sources' existing socket. The alert widget
labels it **Ladder** and schedules it behind supporter events, particularly
subscriptions and raids. The existing clip log records the moment. Optional
bot delivery uses its existing bounded queue and exact token/connection guards;
it never creates or enables a provider connection. Game-widget pause suppresses
ladder alerts while ordinary chat/supporter alerts remain usable.
