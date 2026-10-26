# Build execution scorecard checkpoint

## Current-main integration and API proof

Current checked API HEAD is `2e1ef5673bb57a29d031eceb3f6d048e4b9186a1`.
Root preserved the cache repair at `9e00f9c8`, then normally merged main/Public
`251cb319`. The three source conflicts retain execution hooks and the centralized
owner invalidator, Public's privacy observers and detector-view/Mongo options,
owner-only plan statistics and all setup notes. Source review also confirmed
store-kind typing, GDPR claim retry, restore/unknown-outcome invalidation, Macro
build-change refresh, controlled Builds search and their current mocks.

The independently reviewed `GameDetailsService.upsert` fix retires execution
epochs in an advisory `finally` after every attempted own/opponent log write,
including a committed write whose acknowledgement rejects. Synchronous and
asynchronous observer failures cannot replace the store result. The existing
post-write deletion guard remains. Held scorecard/baseline work cannot return or
populate retired evidence. The actual R2 store has no lower body/read cache:
PUT can precede rejected metadata, but subsequent reads issue fresh GetObject
requests. No additional store cache-flush hook is required for this source.

Focused current-head proof passes all 294 tests in 18 exact suites plus one
snapshot, using serial Jest, the existing local Mongo 7.0.14 binary, downloading
disabled and a new writable workspace cache. This includes the four new
committed-then-rejected/held-response/observer regressions; execution, dossier,
timing and rule consumers; real Public detector/privacy projections; detail
stores; GDPR claim/cache paths and backup restore. Full API types and strict
lint for all 13 feature/repair source/test targets pass without warnings.

The separate three-file legacy lint audit has zero errors and five existing
`max-lines-per-function` warnings: app's makeServices/applyBaseMiddleware/
mountRoutes, builds.detail and evaluator.evaluateRule. No whole-owned-files
zero-warning claim is made. The committed map-pool fixture was copied before
the run and its hash remains identical afterward:
`4d525b8e1a7be49b223a24ea8d7700e58159be5e60c42dd5dc3cdee774af042c`.
Normal Jest's Liquipedia blocker remained active; no fixture or product source
changed during proof. All API jobs closed; no web, build or browser command ran.

Artifacts are root `.cache/execution-integrated-api{,-types,-strict-lint,-legacy-lint}.log`,
`execution-integrated-api-suites.txt`, `execution-integrated-api-strict-files.txt`
and `execution-integrated-api-proof.json`. Web integration checks are queued
behind MoreSheet's exclusive runtime slot. The earlier `53aa5356` web/build/
browser evidence below remains historical and does not validate this merged head.

Branch `codex/wave4-build-execution` starts at preserved Dossier `62b4939c` in
the released SEO tree. SEO `eb18ed52` and caches remain preserved. ADR0060
records the owner-only/shared-request/cache contract.

## Browser runner source and pending web proof

The independent browser runner repair is authored but unexecuted. It accepts
`PW_CHROMIUM_EXECUTABLE`, closes browser/listener resources on startup failure,
and defaults fresh captures to `.cache/build-execution-current-evidence`
(`EXECUTION_EVIDENCE_DIR` can choose another disposable directory). Explicit
theme and storage are set before React mounts; resolved palette/mode checks
guard every navigation. Full-page checks reuse main's shared AA gate, with no
disabled contrast rule or new exception. That helper is retained in the normal
main integration. Original committed screenshots and prior cache evidence remain
preserved; the 15 Dossier/Execution PNG hashes are inventoried in
`.cache/build-evidence-original-shots-sha256.json`. The exact four-file runner
repair manifest is `.cache/build-evidence-runner-owned-paths.txt`.

Only the API proof above has run on the current repair. No new web unit pack,
fixture generator, engine/sample generation, browser or build has run. Counts
below describe earlier verified source and do not verify the merged web or its
new runner. Current engine assets must
follow the integrated source rather than pinning historical bundle25b.

## Historical web/build/browser proof (`53aa5356` and preserved ancestry)

Actual main `d5da6340` is integrated at `29b68dba`; its Reference schema,
completion clocks, Practice priority, exports and editor guards are retained.
The response advertises a supplied private reference only by a bounded flag;
the existing explicit Practice flow fetches it rather than caching its steps.

Peer review caught nonempty malformed/noise-only logs parsing to no events.
They now remain unavailable, including negative and exact-zero rules. Valid
worker-only evidence stays usable. Definition race edits and missing/invalid
custom identities cannot become wrong-faction grades or same-name catalog
lookups. Percentages and timeline baselines remain withheld in those states.

The narrow GDPR/restore seam `d3830616` is integrated at `b750d5c8`, retaining
gameExecution in the centralized private invalidator. A real ranged-wipe
regression proves surviving games lose their old baseline. Known/unknown
game deletion outcomes, full erasure and restore finally retire owner epochs;
advisory callbacks preserve mutation results. Independent API/lifecycle review
is clear, including 400 extra valid-rule combinations checked against legacy
verdict/count parity and strict event deadlines.

Final frozen verification passes 498 API tests across 16 suites/one snapshot,
91 web consumers across nine suites, full API/web types, strict new-source lint
and deterministic Help generation (88 articles). The required 25b engine build
and smoke pass: 223 files/79 pyc, 142,939-byte parse. No engine/native source
changed. The final isolated production build passes every unchanged budget:
landing 190.2/215, Today 238.8/240, game 311.9/440, opponent 448.2/500,
Builds 200.1/270, Dock 215.7/225, AIO 239.7/240 and widget 323.9/325 kB.

The actual GameDetailPage/card/player/Practice loopback browser matrix passes
132 checks with 15 captures at 320/390/768/1440 in both themes. It covers one
shared execution resource, no dossier GET, the same mounted clock/canvas,
rail percentage, event/deadline/timing seeking, two/three samples, unknown and
unavailable states, catalog/zero-rule builds, explicit Practice options,
Retry, held-response owner loading/B/A, overflow, targets and scoped axe.
All nonlocal requests are blocked and all writes rejected (zero attempted).
Capture inspection fixed the ring's RGB-token syntax; a computed-gradient
browser assertion now guards it. Seven reviewed representatives are committed
under `docs/handoff/screenshots/build-execution-*`; full evidence remains in
`.cache/build-execution-evidence`. Root UI/visual signoff is complete.

The approved shared tab-strip fix `97cd44c6` is integrated, then reconciled
with its actual main squash `9f9e6439` at `deb0e438`. Both merges preserve
the reviewed Scorecard source and all additive changelog entries; the actual
squash reconciliation changes no application bytes. The live opponent section
order is unchanged. All 133 affected web consumers across 14 suites, full web
types and strict changed-source lint pass. The final isolated Next-only build
passes every unchanged budget (opponent 448.3/500 kB); refreshed browser proof
passes 132 Scorecard checks/15 captures and 53 passive-scroll checks, with
nonlocal traffic blocked and zero writes. No shared engine rebuild was needed.

Remaining: coordinated draft PR, Dossier dependency merge, exact-head
CI/Vercel and merge.
No production/provider operations or environment/version/release changes.
Any future required-engine build must coordinate the integrated current source;
the bundle IDs in this historical section are evidence, not pins for reuse.
