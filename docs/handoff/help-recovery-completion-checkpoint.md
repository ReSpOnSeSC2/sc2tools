# Help and recovery completion slice — 2026-10-28

Prepared on `codex/help-recovery-completion` at verified base
`477298dd7c397af2baaa79d19736ae43d1a4510d` in the isolated worktree of the same
name. Focused unit tests, whole-web types and scoped lint pass as recorded below.
Build, browser, CI, commits, pushes, deployment and production acceptance remain
with the root release run.

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
- `profiles-replays-polish-1` requires the analysis-shaped loading boundary at
  the canonical `/players/[player]/replays/[gameId]` route. The missing boundary
  now uses shared accessible skeleton primitives, matching hero, five statistics,
  navigation, timeline, mechanics and build-order shapes. Legacy redirect routes
  and all fetch/cache/status/privacy behavior are untouched.
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

Root owns production build/all 83 unchanged route budgets, responsive/AA
inspection and exact-head release gates. In particular check the three update
actions and demo error footer at 320/390, browser file-chooser recovery, and the
canonical loading route including tab containment at 320. A cache-only fixture
is under independent preparation; it has not run here. No owned application
server, browser or native process was started. No infrastructure, provider,
database or configuration change is required.
