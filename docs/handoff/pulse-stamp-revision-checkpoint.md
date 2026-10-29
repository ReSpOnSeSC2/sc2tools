# Pulse game metadata revision: local verification

This local slice is based on the preserved Carry prerequisite
`50468e8a26716a3117fc4c47a3bd3b78e036efcc`. Passed main
`2a2bb882b7cf6f77da9ff1616e50fadfd0e52ba1` contains newer Auth, Macro,
BuildState and Opponents work. Normal integration is the next local gate;
no older file is intended to replace current main.

Only the existing background job's independent MMR and league stamps gain a
named count-neutral operation. The selected BSON game identity, owner and
provider inputs are copied before awaits. The helper owns the two field/marker
pairs, exact owner and numeric/one-shot predicates, and no-upsert behavior.
Provider calls stay outside transaction retries; transport errors remain
retryable, while completed misses consume only the applicable marker.
The original replay-date/import-date bounds, race/value limits, candidate cap,
advisory job lock and post-cycle league refresh remain.

The same admitted causal owner-first transaction changes the game and UUID,
then carries only an already strict ready protocol-2/maintenance-2 count/latest
tuple, or leaves invalid proof retired for authoritative reader fallback.
This does not certify expanded chart dependencies. No count/latest recount is
added to a neutral operation. Known abort rolls back both game and authority;
unknown commit is reported as a write error rather than invented success.

New source tests cover fixed-field authorization, BSON snapshots, independent
field outcomes, actual replica-set transaction commands, owner/fence/epoch
races across held provider work, concurrent ingest, rollback, transient retry,
lost commit acknowledgement and actual shutdown/drain ownership. Original
enrichment and Carry assertions are unchanged. Source02 passed 221 tests in
9 files, whole-API types and scoped lint with the pinned cached MongoDB 7.0.14,
downloads disabled and Jest in band. Three new files are strict-clean; no new
normal or strict legacy diagnostics were added.

The Jest child exited 0, but its original wrapper exited 1 on an unproven
conhost observation. Two incomplete/unproven historical scope rows were
retained. Fresh global settlements 01, 02 and 03 found both absent with no
potential orphan or listener; final cleanup covered 10 exact identities and
used no kills. This is absence evidence, not retrospective ownership or a
claim that every wrapper exited 0. Root authorized only remaining types/lint
after the first strict settlement.

The initial Source01 run passed the same tests/types but failed strict lint on
new stampStatus complexity 15. That failure is preserved. A reviewed pure
per-field outcome extraction preserves error, skip, enriched and miss ordering;
Source02 then passed current checks. The current receipt is
`checks-07/LOCAL-READY-01.json` (SHA-256 `efe4cc3d111674f06bb6f32c37b8ba858d79db50816e9654b1ef619efde12511`)
in the local Pulse validation cache. This checkpoint prose follows the
Source02 guards; the 1010 tested API inputs remain byte-identical. CI,
integration and delivery remain pending.

Custom classification, linked rename, EOF bulk publication and region/identity
writers remain separate. Writer cohort retirement, common-fleet/dependency
guards, CI/deployment and cache activation are unfinished. No provider calls,
new flags, schema/protocol bump, infrastructure, native or asset work is part
of this slice. `USER_CACHE_ENABLED` remains off; the 197-item ledger and its
124 completed / 53 partial / 20 open / 73 unfinished counts are unchanged.
