# Device REST reuse helpers — unwired preparation

The original `codex/device-auth-rest-reuse-helpers` slice, preserved at
`c3d7a592`, was based on tested Auth `e0c47b9c`. It left existing production
modules untouched and had no production imports. The helper behavior and
59-case verification below are historical evidence for that slice.

The current prepared-readiness candidate was integrated with passed main
`dfe4d623` at `98b9cfff`. Readiness now imports the deadline helper and Pairings
shares the authoritative lookup/touch core. The optional retained REST adapter
is still not created or injected by the serving app; REST and sockets use
authoritative lookups. No cache activation or flag change is included, and the
broader faster-dashboards item remains partial.

The standalone lease helper performs demand-only actual majority nonce writes
against the existing authority record. It cannot create, prepare, repair or
activate that record. Its 1.8-second local deadline starts before command
dispatch and includes response/session cleanup. Cache-only cold reads use a
fresh causal session advanced to the acknowledged grant's operationTime,
primary preference and majority concern. They keep the original active-token
predicate and narrow projection. A separate reader copies the existing
best-effort stale-touch behavior; the public authoritative service is untouched.

The installed MongoDB driver 6.13 drops collection-option write concern when
an operation sets `timeoutMS`; the real command-monitoring regression caught
this. Grants instead use the supported raw atomic `findAndModify` command with
literal majority/journal/write-timeout fields and CSOT in its separate options.
This preserves actual write concern while bounding pool checkout and transport.
Unknown/raw write-concern failures cannot grant. Actual probe/session work stays
charged through settlement even after the independent local caller deadline.
Cold reads retain their majority concern. No driver or dependency was patched
or upgraded, and earlier failed assertions/candidates remain in evidence.

Positive retention uses an absolute maximum 60-second token lifetime, a stable
owner hash, incarnation/generation and the observed lastSeen timestamp. A due
or malformed timestamp cannot retain a positive. Scheduled touch success is
never assumed. Reacquiring the same generation may reuse a completed eligible
entry; a held read or prepared ticket cannot bind to a newer grant. The one-use
ticket's consume operation is synchronous, so eventual middleware wiring can
validate immediately before its original auth metadata and next callback.

One lease/cache instance must be shared per process/app at any later wiring;
constructing helpers per lookup would defeat these instance-level bounds.
Keys, entries, tasks, subscribers, preparation/ticket records and accounted
bytes are bounded. The 512 KiB figure accounts cache keys, positive bodies and
fixed task/ticket allowances. Lease/probe/read-session/preparation/waiter objects
are bounded separately by count; this is not a total JavaScript/driver heap cap.
Timed-out or evicted actual work stays owned until real settlement.
Null decisions require a separately issued original lookup; no
old shared result is returned as fallback. No negative cache, polling, new
endpoint, environment flag, infrastructure or provider change is introduced.

Under continuous demand each process may perform one majority nonce write per
1.8 seconds; a rejected cache-owned cold read followed by the required independent
baseline may perform two token queries. Valid retained hits perform neither a
token query nor a touch. No latency, capacity, infrastructure-cost or savings
improvement is claimed without measurements of the real request mix.

The final focused run passes 59 tests in four suites with zero skips, including
actual command-monitoring majority/journal and causal `afterClusterTime`
assertions, raw acknowledgement failures and real pool pressure. Whole API
types pass. Strict lint and explicit DoD checks cover all ten new JavaScript
files: no warning/error, no function over 60 lines or complexity 10, and classes
of 120/47 lines with six/three public methods. No original assertion or rule was
removed or relaxed. All existing tracked production source remains unchanged.

Local Mongo verification uses the pinned cached 7.0.14 binary, downloads disabled
and one in-band member. Tests use an explicitly activated LOCAL test record;
this cannot activate an environment or prove a serving-process cutover. The
local pool
fault test enables test commands only on its owned ephemeral Mongo instance and
blocks one connection; no serving environment or provider setting changes.
The writer-ordering test uses virtual elapsed clocks and separate coordinators
in one process. Separate-process/election and host-clock-rate/suspension
validation remain obligations. The stronger cache-only snapshot read does not
upgrade original credential-write durability or independent baseline semantics.

Earlier declaration/type and complexity failures, a one-member secondary-client
setup timeout, and the actual missing-wire-write-concern failure are retained
under `.cache/device-auth-rest-reuse-helpers-20261028`. Correcting the fixture to
a collection-level secondary preference preserves the real primary-override
assertion. The pre-direct-command candidate and its passing 53 cases remain
historical, not a current combined result. Mongo-memory-server's shutdown socket
reset warnings are retained; exact recorded Mongo/killer/Node PIDs and listener
cleanup are verified separately. No unrelated process is stopped.

The source contract is cache-only
`C:/SC2TOOLS/.cache/device-auth-rest-reuse-phase2-contract-03-20261028.json`
(SHA256 `8dc6e9737f23e05aa838e692f41b553bddb29bc9a3784832bbd1cc30f61e956b`),
reviewed in `device-auth-rest-reuse-phase2-independent-review-03-20261028.json`
(SHA256 `b2cea4f0063a7dbcac1d4ebc80bd76ad0d99b937da2d70dd13cd2161de6a391c`).

Production wiring is a separate step after the coordinated credential writers
are actually deployed and an incarnation-qualified credential cutover settles
old unregistered actors and unknown work. The game-stats cutover is different
evidence. Missing/recreated authority and empty pending cannot prove readiness.
Existing 2.1-second writer drains and sticky uncertainty remain mandatory.
Activation/rollback must use the reviewed durable disable/drain protocol.
Current token-write concern, independent baseline snapshots, already admitted
requests and open sockets do not acquire a stronger revocation guarantee here.
