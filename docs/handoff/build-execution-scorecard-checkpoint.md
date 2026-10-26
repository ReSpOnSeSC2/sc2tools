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
and `execution-integrated-api-proof.json`. The accepted API/agent/engine source
remains identical through the current web integration below. The earlier
`53aa5356` web/build/browser evidence remains historical.

Branch `codex/wave4-build-execution` starts at preserved Dossier `62b4939c` in
the released SEO tree. SEO `eb18ed52` and caches remain preserved. ADR0060
records the owner-only/shared-request/cache contract.

## Current integrated web/build/browser proof

Root preserved the API checkpoint at `d5d36c76`, integrated main `8d7ec51d` at
`804a5f6d`, preserved the Dossier fixture correction at `d627eb37`, then normally
integrated urgent main `1c3d9877` at `35ec229a`. The final local source adds the
reviewed BuildStatsRow semantic repair and its existing-test regression, plus
removal of the stale Execution Help mock. The urgent Macro selector placement
is integrated normally, with its callbacks retained. No API, native or engine
source changed from the accepted 294-test proof.

The prepared web pack passes 254 checks in 31 exact suites at `804a5f6d` using
at most two workers. Current-main semantic follow-up passes 20 checks in the
two BuildCard/Held suites, including ready/loading/unavailable definition-group
regressions. Full web types pass before and after the replacement production
build. Strict lint passes for 35 changed files and the narrow follow-up test/
fixture files. The separate inherited audit records four existing JSX wrapper
warnings across BuildCard and BuildsTab.tablePolish, zero errors; the later
BuildCard-only audit retains its same two warnings. No waiver was added.
All 19 UI rules and the 1,679-file/656-existing-occurrence ratchet pass with no
new or stale allowance. Help generation yields 89 articles with unchanged
content; its LF rewrite was restored to the exact original CRLF SHA256.

Initial types found a stale ignored Community index checker. All 115 prior
generated type files were copied and hash-verified in
`.cache/execution-before-public-typegen`; supported Next typegen refreshed the
current routes. Only the unchanged obsolete checker was retired after verifying
the old source was absent and the directory-group source existed. No tsconfig,
source exclusion or broad cache cleanup changed.

The retained current engine is `1.6.12/d27b37abb9997712`, agent `0.24.7`.
All 40 normalized allowlisted inputs match the validated Try source. Its ZIP
is 1,252,988 bytes with SHA256
`ba357c54c2f3d69b923adc391230dc4382693eabb697b23bf287a665ad1f0858`.
Only its missing immutable ZIP/manifest were copied; four matching Pyodide
assets were reused, the ignored pointer changed atomically, and old 25b files/
pointer bytes were preserved. No engine compile, download, publisher or pruning
ran. Receipts are `.cache/execution-current-{engine-input,assets}-proof.json`.

Actual browser proof exposed three issues before the final green runs. The
Dossier host passed removed timingContext instead of the parent's execution
DTO; its fixture now supplies a typed bounded synthetic timing sample. Shared
full AA then caught invalid nested definition lists in BuildCard. Its layout
wrapper is now a div, Win rate/Record form one valid dl, and Held has its own
dl; classes, values and handlers are unchanged. Execution's bare Help mock
dropped the actual link styles, so that mock was removed and real current Help
links now run. All original interaction and AA assertions remain enabled.
Failed evidence/logs/host bundles are preserved in the three initial final/
retry evidence directories. The first production artifact is historical to
that failure; the replacement build validates the repaired integrated source.

The replacement direct Next build passes 142 generated pages and every
unchanged limit: 18 listed routes plus 63 default routes (81 actual checks).
Game is 315.3/440, opponent 458.7/500, Builds 202.7/270 and Community 188.4/190
kB. Post-build full types pass. The pinned Chromium 1228 matrices use the new
production CSS/fonts at 320/390/768/1440 in Light and Dark, with reduced motion,
theme-before-mount checks and `A11Y_COLLECT_ONLY=0`. Dossier passes 262 checks,
32 captures and 25 full AA calls; Execution passes 157 checks, 15 captures and
nine full AA calls. Contrast is enabled with no new exception. Clock/canvas
identity, event/deadline seeking, rail percentage, one execution read, absent
log withholding, Practice, Retry and held-owner ABA assertions all pass.

Final evidence is `.cache/build-dossier-insights-final-semantic-evidence` and
`.cache/build-execution-final-real-help-evidence`. Every API call is asserted
GET and zero writes are recorded. Nonlocal requests are blocked; these runners
do not count attempted external requests, so their hardcoded externalTraffic
field is not evidence of zero attempts. All browser/listener jobs closed.
Six phone/desktop representatives were visually inspected as contained and
legible. Original 15 committed PNGs, 16 older evidence files, five old host
files and prior engine assets retain their recorded hashes; the map fixture
hash above is unchanged. `.cache/execution-final-proof.json` records the exact
staged boundaries, preservation and final receipts. No production/provider,
native SC2/agent or release operation ran.

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
# Current shared-navigation reconciliation

Actual More main `378a957d` is normally integrated at `bb543a15`. Owned Execution,
Dossier and semantic-card sources are byte-identical to the reviewed replacement
artifact at `48f90d5e`; API, agent and engine trees remain identical to accepted
`2e1ef567`. The independently changed navigation is additionally covered by
77 checks across four AppChrome, BuildCard and real Macro-editing suites, plus
whole web TypeScript. Both are green. The replacement local production/browser
artifact above predates this independent navigation integration; fresh exact-head
API/web/responsive CI is still required.

Root reviewed and preserved four synthetic captures under
`docs/handoff/screenshots/build-dossier-final-*` and
`docs/handoff/screenshots/build-execution-final-*`; copied bytes match the final
cache artifacts. All historical captures and failure evidence remain intact.

# Current browser-demo reconciliation

Merged Try main `90c444d8` is normally integrated at `9e8d6128`; the owner setup
conflict retains both private execution and home-page demo instructions. API,
agent and engine source trees are byte-identical to fully green `9f59fa96`.
All 106 combined UI checks across nine suites, whole web types, all 19 UI rules
and the 1,693-file/655-occurrence ratchet pass. No new allowance or source repair
was needed. The prior execution head passed 6,261 API tests, 8,774 web tests and
371 responsive/browser checks; a fresh exact-head CI run is required after this
independent main integration. Local production/browser proof is unchanged and
predates only that integration.

