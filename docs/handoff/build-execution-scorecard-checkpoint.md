# Build execution scorecard checkpoint

## Required current-main repair before delivery

Read-only integration review found that `GameDetailsService.saveBuildLogs`
retires execution caches only after the store write acknowledges success.
The R2 store can commit its object PUT and then reject metadata, leaving an
unchanged slim-row key with old execution or baseline evidence for five minutes.
Before merging this pack, invalidate the log attempt in an advisory `finally`
without masking the original result. Add committed-then-rejected and held-response
regressions, retaining the existing post-write ownership/deletion guard.
This repair is not implemented or runtime-verified by the runner-only work below.

Branch `codex/wave4-build-execution` starts at preserved Dossier `62b4939c` in
the released SEO tree. SEO `eb18ed52` and caches remain preserved. ADR0060
records the owner-only/shared-request/cache contract.

Current-main integration audit (source only, no new runtime proof): the old
branch still needs normal integration with main and the public-player pack.
Before merge, log-write cache invalidation must cover a store that commits and
then rejects; the current callback runs only after successful acknowledgement.
Retain main's store-kind typing, GDPR claim retry, Community observers, Macro
build-selection refresh and controlled Builds search alongside execution hooks.

The independent browser runner repair is authored but unexecuted. It accepts
`PW_CHROMIUM_EXECUTABLE`, closes browser/listener resources on startup failure,
and defaults fresh captures to `.cache/build-execution-current-evidence`
(`EXECUTION_EVIDENCE_DIR` can choose another disposable directory). Explicit
theme and storage are set before React mounts; resolved palette/mode checks
guard every navigation. Full-page checks reuse main's shared AA gate, with no
disabled contrast rule or new exception. That helper arrives with normal main
integration. Original committed screenshots and prior cache evidence remain
preserved; the 15 Dossier/Execution PNG hashes are inventoried in
`.cache/build-evidence-original-shots-sha256.json`. The exact four-file runner
repair manifest is `.cache/build-evidence-runner-owned-paths.txt`.

No tests, fixture generator, engine/sample generation, browser or build has run
for this repair. All counts below describe earlier verified source; they do not
verify current-main integration or the new runner. Current engine assets must
follow the integrated source rather than pinning historical bundle25b.

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
Required-engine builds must coordinate current 25b; never run old f96 prebuilds.
