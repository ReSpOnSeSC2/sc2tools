# Help and recovery completion slice — 2026-10-28

Prepared on `codex/help-recovery-completion` at verified base
`477298dd7c397af2baaa79d19736ae43d1a4510d` in the isolated worktree of the same
name. Focused unit tests, whole-web types and scoped lint pass as recorded below.
The root subsequently stacked the exact source patch onto the reviewed dashboard
candidate for combined build verification; only additive changelog placement
changed. CI, push/merge and production acceptance remain separate release gates.

## Scope and original requirements

- The website update prompt now offers **What changed** → `/changelog`, with
  prefetch disabled. **Later**, explicit **Reload**, update deferral and focus
  restoration retain their handlers. Its action row can wrap on narrow screens.
- `help-and-feedback-menu` explicitly requires What's new once that destination
  ships. The shared registry now supplies it to both desktop Help and mobile
  More, including signed-out desktop Help. It opens the existing public
  changelog; no account preference or seen-state write is added.
- Both normal and terminal/replaced Dock **Open Overlay settings** links now
  include `section=setup`, preserving new-tab behavior and token-free URLs.
  This follows the delivered Settings section registry rather than changing any
  Dock socket, retry, studio or provider behavior.
- `profiles-replays-polish-1` requires an analysis-shaped loading surface for
  `/players/[player]/replays/[gameId]`. The complete skeleton uses shared
  accessible primitives for the hero, five statistics, navigation, timeline,
  mechanics and build orders. Its final placement is an SSR-enabled dynamic
  analysis island returned only after the existing authenticated API result,
  404 and canonical redirect decisions. No extra API request is added.

  The original named `app/.../loading.tsx` artifact conflicts with the later
  ADR 0065/status contract: a route fallback can flush 200 before sharing or
  replay existence is known. CI caught the unsafe first placement. The same
  skeleton now lives in `SharedReplayAnalysisLoading.tsx`, used by the real
  `next/dynamic` loading boundary in `SharedReplayAnalysisContent.tsx` after
  authority has resolved. The forbidden route artifact is absent. This
  implementation-path substitution preserves the full loading UI, existing SSR
  and all status/privacy assertions; it does not claim the literal old filename
  was delivered. Legacy redirects, metadata, query sanitization and the single
  request-cached API loader are unchanged.
- `landing-try-polish-1` requires the selected filename/size while parsing and
  **Choose another replay** after error. `landing-demo-in-browser` explicitly
  retains those earlier affordances. The private session and optional-island
  loading/error views now show the local file and size. Parse errors focus their
  heading; another-file recovery invokes the existing picker after retiring the
  old parent request. Existing same-file Retry and optional-chunk Retry remain.
  No replay upload, fallback, persistence, engine or rollout flag is added.

Help updates explain release-note entry points, waiting-update consent, direct
Dock Setup navigation and the private demo's recovery. Changelog is additive.
Macro and the roadmap ledger are untouched. This slice alone does not complete
all requirements of any larger roadmap item or the 197-item program.

## Focused verification

- Existing ServiceWorker tests retain Later/Reload/session/focus assertions and
  add the release-notes destination without update activation.
- HelpMenu and actual AppChrome More tests require the shared changelog link.
- Actual Dock tests require the Setup section for normal and terminal links.
- A canonical loading-route test checks one busy announcement and no fake
  replay data/actions.
- Actual private-session tests cover filename/size during a held scan,
  cancellation/late completion, error-heading focus, choosing a replacement,
  input reset and successful parsing without an API call. Optional-island tests
  retain rejection/throw/deadline recovery and check picker access/file details.

Executed serially using retained dependencies through a web `node_modules`
junction; no dependency downloads or asset generation:

- Eight focused component suites: **117 tests passed**, maximum two workers.
- Help article and in-memory generated-index validation: **31 tests passed**,
  maximum two workers. No generated registry file changed.
- Whole-web `tsc --noEmit --incremental false`: passed, observed tool exit 0
  with no stdout/stderr. This receipt is in the tool transcript, not a disk log.
- ESLint for every changed/new web TypeScript file, `--max-warnings=0`: passed
  in two serial invocations (16 modified files, then the two new loading-route
  files). Both tool exits were 0 with no stdout/stderr; transcript receipts only.
- Independent source review found no concrete blocker. The skeleton navigation
  placeholders explicitly wrap to preserve containment at narrow widths.

Unit stdout receipts are retained in
`C:\SC2TOOLS\.cache\help-recovery-completion-verification-20261028`:
`unit-02.log` and `help-unit-01.log`.
`unit-01.log` preserves the initial environment failure: the dependency junction
was absent after a sandbox-denied creation, so no tests started in that attempt.
Creating the authorized reuse junction with elevation resolved it.

The original checkpoint incorrectly listed `web-types-01.log`,
`web-lint-01.log` and `web-lint-new-01.log` as retained files. Their `Tee-Object`
pipelines received no output from the successful tools and did not create those
files. No alternate receipt packet exists. `receipt-audit.json` records the exact
prior invocation and exit-0 transcript references, explicitly as a retrospective
audit; it is not regenerated tool output. No checks were rerun for this repair.

The root's combined all-features production build passes all 83 unchanged route
caps (18 explicit/65 default), with 40 canonical engine inputs, seven retained
assets and the strict four-game sample unchanged. Post-build standalone whole-web
types pass, as does strict lint of all 18 changed TypeScript files. The first
root lint command accidentally selected zero files because its Git pathspec was
relative to apps/web; it ran the whole application and failed on inherited
warnings. The corrected invocation asserts exactly 18 files and passes. Both
logs remain retained; no lint gate was relaxed.

Independent component browser acceptance passes 30 cases at 320/390/1280 in both
themes, including 48 complete AA scans with zero violations. It exercises the
real replacement file chooser/controller, error/unsupported and chunk-failure
recovery, long filename containment, Later/Reload/link/focus behavior, shared Help
and canonical skeleton. Engine/API/SW boundaries are explicitly intercepted;
this is not deployed account acceptance. Initial fixture setup failures remain
alongside run05, original screenshots and the independent source-pin receipt.
The source rebase preserves all consumer trees/dependencies; the extra conditional
API allowlist is outside the fixture's explicit clientApi boundary. No browser
rerun was substituted for live proof.

No application listener, native process, provider setting, infrastructure or
database change is required. Exact-head CI, merge, production source/deployment
and relevant real signed-in links remain to verify before delivery is claimed.

## CI-discovered authority correction

At head `7b57d86e1de7121bdc4eeac1a96a723d371b2d3d`, web CI run
`40630331297` failed the existing `publicStatusBoundaries.test.ts` assertion.
The other 9,981 executed tests passed, with one existing skip. The failed check,
annotation and bounded-log summary are preserved; the unsafe route fallback was
not merged. The existing status-boundary test remains byte-identical.

The corrected page keeps all authority branches before the dynamic island,
with default SSR enabled and no artificial delay or data refetch. Seven new gate
tests cover held authority, page/metadata 404, API failures and canonical redirect.
The first standalone type run caught a widened boolean in the new test fixture;
its result type is now explicit, and whole-web types pass. Three old replay
consumer assertions now await the genuine lazy component before checking the
same content/navigation/download behavior; no assertion was removed. The
original synchronous failures are retained. The combined gate, existing detail,
fetch-cache, skeleton and middleware suites pass 79 cases; strict repair-file
lint passes. The corrected all-features production build passes all 83 original
route caps and unchanged asset admission. Twelve fresh browser cases and 18 AA
scans pass at 320/390/1280 in both themes: six unchanged skeleton checks and six
genuine held-ESM-chunk handoffs through the installed Next App Router dynamic
loader into the real analysis. Focus and vertical scroll stay unchanged.

Actual local production Next HTTP/SSR was compared with the merged dashboard
build using the unmodified Clerk SDK/middleware, generated in-memory test keys,
loopback JWKS and synthetic replay authority. Both authenticated held requests
stayed header-free until the authority returned, then produced real 404s. Both
builds return complete analysis HTML after script/style removal; canonical and
legacy redirect destinations/context, auth negatives, busy/outage behavior and
per-case authority request counts match across all nine cases. No production
credentials, account or provider request was used.

The strict HTTP runs remain **7/9**, not 9/9: canonical and legacy detail redirects
make two identical authority reads on both baseline and candidate, failing the
fixture's one-read expectation. Those assertions and failures are retained. The
separate nine-case comparison proves no introduced status or request-count
regression; it does not resolve the existing redirect double-read observation
or claim one read on those paths. Ordinary admitted/missing/error cases make one
read. Initial sandbox-loopback and IPv4/IPv6 fixture failures are also retained.
All owned Next processes and loopback listeners closed. Exact-head CI and actual
production delivery remain required before this slice is delivered.
