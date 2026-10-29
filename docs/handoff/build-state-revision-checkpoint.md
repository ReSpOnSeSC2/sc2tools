# Build-state revision: locally verified prerequisite

Base: clean Carry/main integration `50468e8a26716a3117fc4c47a3bd3b78e036efcc`
on `codex/build-state-revision`. Source04 passed independent review and local
API checks. Current-main integration, CI, deployment and acceptance are pending.

Four named count-neutral operations cover build-intent game update, bounded
pending dismissal, fresh pending marking and claimed live-record binding.
Each owns its original complete filter, explicit no-upsert and per-kind field
allowlist. Only plain `$set` pipeline stages on those paths are allowed;
the server schema value is checked. Pipeline and owner BSON copies reject
normalization and remain fixed across floor/transaction awaits and retries.

The existing owner-first transaction primitive carries only a strict ready
protocol-2/maintenance-2 count/latest preimage to its new UUID. Invalid, old,
unsupported or missing proof retires without a history recount. Eager count
maintenance, raw-date authoritative fallback and public DTOs are unchanged.
PUT/dismiss capture once before reads. Binding receives the ingest batch owner
or captures once for direct entry, preserving that owner across both attempts.

Existing attribution pipelines, first-wins/null/updatedAt guards, the 500-ID
dismissal bound, leases and publication rules are preserved. Live-record
claim/release, option/detail/suggestion reads and notifications stay outside
transaction retries. The existing unknown-outcome claim recovery remains;
cross-collection atomicity is not claimed. Original test assertions remain
unchanged. All 537 tests across 26 files passed with one worker, alongside
whole-API types and owned-file lint with no added diagnostics. Real replica-set
cases cover rollback, retry and lost commit acknowledgement.

The lost-acknowledgement fixture now targets the invoked transaction and verifies
one injection and one actual commit command. Earlier fixture/type/lint failures
are preserved. Source04's receipt is
`.cache/build-state-revision-20261028/checks-04/LOCAL-READY-01.json`
(`b6f606f05da9df129de8246235bcd72ecde9a3d98c658a7e8bbff761a75c5f67`).
All 1,010 inputs and 49 protected assets stayed exact across the three checks.
All 26 observed process identities settled; current and historical unresolved
identities, orphan descendants and listeners were zero, with no kills.

This is not an expanded-chart coverage seal or old-cohort cutover receipt.
Other non-count writer families remain unfinished. The 197-item ledger/count
is untouched. No retained cache activation, flag, migration, provider, native,
engine asset or infrastructure change is included. `USER_CACHE_ENABLED`
remains off. Source preparation evidence is under
`.cache/build-state-revision-20261028/`.
