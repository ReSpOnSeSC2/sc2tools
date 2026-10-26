# Level-up checklist — final local checkpoint

2026-10-26 · `codex/wave5-activation` · checkout
`C:\SC2TOOLS\.worktrees\wave4-agent-dashboard`.
Validated product head: `4c04b200037657b7f19843f788c8cbbc7bab8491`;
tree: `3ab0f9cc102926f5583229b475974d1937c27532`.
Local checks and root visual review are complete; integrated exact-head CI and merge remain pending.

## Behavior and contracts

- Today alone dynamically mounts suggestions after games exist and the existing first-run checklist admits them; no analyzer subpage duplicates.
- Six live flags yield four rows for Improve or Stream alone, six for both/unset/malformed goals. Progress can regress; no seventh completion flag.
- The API uses six bounded, projected `findOne` calls. Its final metadata read requires a surviving owner without a GDPR fence. Failed reads return an honest failure, not false flags.
- Identity requires valid recorded identity data. A nondeleted custom build counts even disabled; confirmed intent requires an eligible live owned game, including owner-visible excluded games.
- Historical overlay-token activity, including revoked tokens, means a link was connected, not a live broadcast. Chat requires exact `true` on a supported platform setting.
- First-game PUT verifies the exact live owned game, then conditionally stamps server time only for a missing/null marker. Valid stamps survive duplicates; no upsert, resurrection or nested lease.
- Generic onboarding updates cannot set `firstGameViewedAt`. Independent `levelUpDismissedAt` is validated and merged without resetting other onboarding fields.
- Private GameDetail admission rejects loading/errors/previous data/mismatched IDs/public pages. Owner/game/lifetime identities retire held JWTs and decoded bodies across ABA changes and unmount.
- Owner-keyed SWR dedupes for 60 seconds and refreshes while visible. An admitted ACK may patch only an existing exact-owner activation answer; no fabricated tuple or extra activation GET per game.
- Dismissal hides only after the exact issuing stamp is acknowledged. Failed/malformed answers retain retry and focus. First-run dismissal remains independent.
- Only current-owner incomplete→complete transitions toast. Initial completion shows the existing What's new link; completed cards still permit dismissal.
- Each row retains one action and its Help link. Phones keep the icon left and action below full-width text; `sm` places the action right. Completed rows have no empty action wrapper.

## Completed proof

- Canonical Help generation exited 0 and indexed 93 articles; the new Your first week article uses the generated registry, with no hand edits.
- Retained API and whole-web types passed. Two API real-Mongo files: 44/44 tests; six Help files: 46/46. Selected web proof totals 108: 96 retained tests plus the repaired 12.
- At `4c04b200`, strict lint of `LevelUpChecklist.tsx` had 0 errors/warnings; its existing 12 unit cases passed again. Eight owned process identities/listeners closed.
- API strict lint preserves its raw inherited 11 function-length warnings, zero errors/new owners/threshold crossings; root accepted only that existing debt.
- The own cda direct Next build, unchanged budgets and postbuild types passed. Its accepted build ID is `txSiXdQcm2MDVtKKf6W7e`.
- Final layout browser RUN at `4c04b200`: 12/12 passed once in 32.1 s, zero skipped/failed/flaky, one full Chrome 1228 worker, retries=0/maxFailures=1, CI=1 and true collection-only key removal.
- All 36 shared WCAG2A/AA/2.1AA serious/critical scans had `issues: []`; raw attachments retain 30 incomplete color-contrast observations. This is not a claim that every contrast node was resolved.
- All 18 captures and 12 fixture closure ledgers were retained; every tracked socket count was 0. Root approved phone light/dark captures: readable text, action below description, no clipping.
- Ledgers contain 54 synthetic GETs and 24 exact PUTs: six marker 200, 12 dismissal 200 and six expected dismissal 503. Errors/unknown/rejected/external/native attempts were 0.
- Positive host closure at 22:47:32 UTC found all 71 recorded PID/name/parent/creation identities and owned listeners absent; no PID reuse or kills in the final run.
- Pre/post guards retained clean `4c04b200`, nine source pins/checkpoint/config, original LIST12/spec, four own CSS files/three fonts/artifact and Chrome bytes. No source/docs/Git changes occurred during that run.

Earlier API/Help/web receipts: `.cache/activation-validation-prep-cda8a531/runs/`; parent-owned host closures are retained beside those runs.
Final evidence root: `.cache/activation-browser-layout-4c04b200/`.
Proof SHA-256 values (files under `proof/`):

- `results.json`: `bd52e4234796e53e6325daebcf0e1bcf2af08b629a9b6e2377c89edad1d5b99e`
- `final-receipt.json`: `5747222863fc992de88101fe7bca2447033178be3b5918af1b895219d173aa61`
- `postguard.json`: `bf75394c2b8948bd8b86365d9f1cd8c8dd9c00da8783c9972608394a360ab805`
- `closure-host.json`: `e2f0b0dd369253dc180e44cd6090f6242c5c6e19835f358e39120949f8b420b0`

## Source, CSS and browser limits

Current component `e19a11fe…` and fixture `43f9ac27…` are freshly esbuild-rendered real sources. The retained own CSS/font artifact remains honestly at sourceHead `cda8a531938f1790614a61625f7e95ad16be1fdf`; it is not a new production build of `4c04b200`.
All exact markup utilities already exist in that artifact's four CSS files; all three own fonts and complete raw hashes match. Artifact path: `.cache/activation-build-prep-cda8a531/browser-build-artifact.json`; SHA `66aef007b775469238b68a0e4f4948885fb15146d0e934f5d395239a0293cef9`.
The explicit bridge is `source-css-bridge.json` in the final evidence root. Only markup, fixture cleanup and documentation changed since the retained build; other production behavior was not changed for the visual retry.
Browser coverage uses actual LevelUp/marker/API/SWR/Help/Modal/Toast in a synthetic framework/auth/HTTP/GameProbe host. It does not prove the entire Today/AnalyzerFrame/GameDetail route; their actual integration seams have separate unit proof.
The six-command absence check may scan owner history; it is not measured constant query cost. Known Node CJS/MJS and Vite CJS tooling warnings remain raw.
The 22-path feature scope adds no infrastructure, migration, index, model feature, provider activation, native release, version bump or tour placeholder. Guided tours are a separate item.

## Preserved failures and before bytes

All paths below are cache evidence, never product/CI dependencies or staged artifacts.

- Original API/web before bytes: `.cache/activation-api-before-9a68c480/`, `.cache/activation-web-before-9a68c480/`.
- First API tuple diagnostic and repair: `.cache/activation-types-tuple-repair-b1aeac69/`.
- First web type failure and actual API0: `.cache/activation-validation-prep-6e9a04ca/`; selector before bytes: `.cache/activation-web-type-repair-6e9a04ca/`.
- Decoded held-body strengthening: `.cache/activation-decoded-body-repair-8dd73509/`.
- First 108-test run (101 passed/7 heading-query failures), raw closure and before bytes: `.cache/activation-heading-query-repair-178c7283/`.
- First browser afterEach socket RED, trace and raw ledgers: `.cache/activation-browser-prep-cda8a531/proof/`; before repair: `.cache/activation-socket-drain-repair-cda8a531/`.
- Intermediate `231f6b62` 12-case/36-AA pass, sandbox-denied host observation and later unrelated conhost PID collision: `.cache/activation-browser-retry-231f6b62/proof/`; no unrelated process was killed.
- Before phone markup: `.cache/activation-phone-row-layout-before-231f6b62/`; final component lint/12 unit cases: `.cache/activation-layout-checks-4c04b200/`.
- Before this documentation-only condensation: `.cache/activation-checkpoint-finalize-before-4c04b200/`.

The first failures remain failures in their raw receipts; later passes do not overwrite them. This checkpoint update launched no runtime/build and changed no product or tests.
