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
or account writes are submitted. The independent source review is clear at
parent-integrated `1e1a736ff8d43fef7e91abaf2db8fd4a21073e07`: the ten non-changelog
Unit pins and eight protected files remain exact after the normal merge of
main `76fbc441`; its inherited changelog change is explicitly qualified.

No new endpoint, polling, cache activation, flag/provider/security change,
infrastructure, engine/native source or asset regeneration is part of this slice.
Keep `USER_CACHE_ENABLED` off. Preserve all original route caps and shared assets.

## Completed local release gates

Historical production diagnosis used DOM/screenshots, without network tracing.
No quiz answer/XP attempt, settings Save or personal upload was performed.
Normal activity/touch/autosave behavior was not measured; universal absence of
account writes is not claimed. The local GET-only/write-guard proof below uses
explicit synthetic account and transport seams.

Direct production Next build `bYQf505RuQP3HOsucpPUj` passed all 83 unchanged
route budgets. The 40 canonical engine inputs, seven active assets and strict
four-game sample matched before/after build and after browser QA. No generator,
download or asset pruning ran. All 6,843 source inputs matched at prebuild,
postbuild and postbrowser; the independent reviewer rehashed them before this
documentation adoption. These are historical build guards: this checkpoint
update and the new compact evidence files are subsequent documentation-only
deltas, while every runtime Unit source and protected input remains unchanged.

The local responsive matrix passed eight cases at 320/390/768/1280 in both
themes, with 40 full default Axe scans, zero violations/exclusions, 40 geometry
specimens and 24 retained LOCAL captures. Actual hooks/SWR, seven-page corpus,
catalog/session providers, ModeRunner and the Unit Profile generator/renderer
consume 177 exact build-admitted product inputs, fresh production CSS and local
fonts. Auth, seed, account-write sinks, GET-only HTTP and Next primitives are
explicit fixture adapters. Native Tab/Enter exercises only Retry; no answer or
account write is submitted. This is component QA, not an actual Next route,
provider, account, scan-speed measurement or live acceptance.

The loading, error/Retry, ready question, successful 24-game insufficiency and
unrelated-mode states passed. Representative 320px light loading, 390px dark
error and 390px light ready images were independently viewed and are legible
and contained. No private production image is copied or used as postchange
acceptance. Build, test/type/lint and browser cleanup receipts show no remaining
owned processes/listeners; no unrelated process was stopped.

Compact receipts and three reviewed local images are in
[validation/unit-profile-history](validation/unit-profile-history/README.md).
The raw 3 MB report, traces, all 24 captures and complete source snapshot remain
in the cache packet. Exact-current-head required CI, actual deployment and
signed-in production acceptance still remain. The roadmap ledger is unchanged;
no release or whole-program completion is claimed.
