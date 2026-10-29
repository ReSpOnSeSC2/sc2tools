# ADR 0071: Prepared credential authority and optional REST reuse

Status: prepared writer/readiness prerequisite delivered in PR813 (`b8608d90`); retained authentication remains unactivated.

Actual Ready/Live source and one prepared/causal startup attempt are accepted
in [the sanitized delivery receipt](../handoff/validation/device-auth-prepared/production-b860.json).
That attempt proves neither ongoing incarnation nor old-actor/unknown-work
settlement. Ordinary REST/socket authentication remains authoritative and the
optional retained adapter is still uninjected.

The deployed credential writers coordinate issuance, revocation and erasure.
The earlier approved read-only observation found their authority absent. Its legacy
retirement inference and causal majority read establish neither an incarnation
nor settlement of current handlers paused before credential enrollment.

The shared writer obtains acknowledged prepared authority and validates the
same incarnation before dispatching credential work. The server attempts this
before constructing the app. Metadata failure is nonfatal: ordinary REST and
socket authentication retain their original token query, projection, result and
errors. Mutations fail closed before their callback unless preparation and the
existing durable gate/drain succeed.

Preparation has one actual attempt, eight waiting callers and a fixed
five-second caller lifetime. Its actual command/session work remains owned
after timeout. Late results cannot publish readiness or escape the admission
bound. Shutdown retires readiness synchronously and drains actual work before
Mongo closes. An already-running callback retains its existing outcome and
durable uncertainty behavior.

The existing acknowledged hello supplies a separate credential capability.
Supported replicated topology requires actual operationTime, primary-majority
validation at that floor and exact schema/incarnation. Positively identified
standalone supports coordinated writer-only preparation without claiming causal
retention. Missing, contradictory or unsupported topology never selects this
compatibility path. There is no environment/error-based bypass. Standalone and
unknown contexts cannot construct a retained REST adapter.

Public Pairings and cache-only lookup share one mechanical core. Only the
cache-owned private closure passes a causal session and stronger read options.
Public callers retain the original predicate/projection and best-effort stale
timestamp touch, including equality. Proof/timestamp data never enters the
public DTO. Sockets retain the original public lookup.

Optional REST middleware prepares a ticket, then consumes once, assigns the
unchanged auth object and calls next synchronously. Rejected/expired/missing
tickets invoke one new independent original lookup; a cache result cannot be
renamed as fallback. The app does not inject this adapter in the prerequisite
release, so prepared metadata adds no grant probes to ordinary authentication.
No code creates active mode or clears uncertainty.

Before activation, qualify the entire prepared serving cohort, retire/drain every
prior pre-readiness actor (including df5-derived releases) and actual lifetimes
(or bind explicitly qualified provider retirement
and settlement), then freshly read that same prepared incarnation at a causal
majority boundary. Preserve pending/denyAll. Missing/recreated authority requires
new binding. Real clock/election/cross-process assumptions, release gates and a
separately reviewed expected-incarnation/generation activation CAS remain due.

Rollback keeps coordinated writers until grants are durably disabled and the
full old-grant drain passed. Reader rollback does not remove writer gates.
Provider, flags, infrastructure, engine and native release stay unchanged.
USER_CACHE_ENABLED stays off and faster-dashboards remains partial.
