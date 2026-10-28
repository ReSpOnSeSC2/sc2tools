# Unit Profile history readiness — 2026-10-28

Candidate: `codex/unit-profile-history`, starting at main `2242d112`.
This is an owner-reported Arcade correction; the wider197-item program remains
active and incomplete. No delivery or roadmap closure is claimed here.

The owner saw "Not enough data yet" and "Play more games" despite13,471 saved
games. The separate `/v1/arcade/unit-stats` request was excluded from the shared
dataset's loading/error state. Until it returned, `unitStats:null` reached the
quiz's genuine minimum-data gate. The owner's same production page eventually
produced a real unit question without an answer submission, confirming usable
details and the false early state. The preserved prechange capture is
`.cache/unit-profile-history-fix-20261028/production-before.jpg`; it is historical
diagnosis evidence, not acceptance of this candidate. Prior aborted request logs
do not establish the eventual response's duration or a performance improvement.

The hook now supplies separate unit-history readiness and Retry. Only Unit
Profile waits for that read or presents its error; unrelated Arcade modes stay
usable. Its generator receives successful real aggregates. Existing25 scanned
games,10 loss-data games and6 distinct-unit gates remain unchanged, as do scoring,
daily selection and account-write behavior. Narrow legacy test data sources may
omit the optional readiness envelope; the real hook always supplies it.

The API retains the complete latest1000 eligible-game cap and singleton detail
reads. It projects `buildLog` and `macroBreakdown.player_stats`, rather than the
unused macro event arrays. Existing R2 storage still downloads its compressed
object before projecting; no scan-speed or network-byte saving is claimed.
Actual missing R2/legacy objects still yield absent detail. Strict provider/store
failures and missing service wiring now report a retryable503 instead of a
successful empty histogram. This intentionally replaces the old tests' fabricated
empty-success expectation for unavailable stores; the genuine-empty and count
assertions remain, with additional real store/SDK-command regressions.

Local verification packet: `.cache/unit-profile-history-fix-20261028/verification-01`.
The final API run passes89 cases in4 files, including actual R2DetailsStore and
GameDetailsService with synthetic S3 transport, and unchanged one-live-blob
memory assertions. Web graph regressions use real SWR/useApi, seven-page13,000
game transport, dataset hook, runner and Unit Profile; auth/HTTP transport and
account-write sinks are explicit synthetic boundaries. The final web run passes
82 cases in9 files, including five history-readiness graph cases. Whole API/web
types pass. Scoped web lint and new/changed API production/memory-test lint have
zero warnings/errors. The inherited API service-test file retains four warnings,
with no added or increased debt. An initial lint attempt found the old warnings
and a new61-line unitStats method; folding its one-line wiring guard removes
that new warning without changing behavior. Both focused suites were repeated
after the narrow source repairs, with all failures/logs retained. No quiz answers
or account writes are submitted. Independent source review, production
build/all83 unchanged budgets/assets, exact-head CI, deployment and actual
signed-in acceptance are still required before delivery.

No new endpoint, polling, cache activation, flag/provider/security change,
infrastructure, engine/native source or asset regeneration is part of this slice.
Keep `USER_CACHE_ENABLED` off. Preserve all original route caps and shared assets.
