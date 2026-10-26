# Admin design gallery and UI lint ratchet

2026-10-25. Worktree `wave3-game-workspace`, branch
`codex/wave5-ui-primitives`, integrated source base `4e64c68af63dae6f65c5ca868d107d876e79e4d0`.
This extends the reusable-contract pack; broad consumer migrations and completion
of the whole `ui-primitives-and-dialogs` item are not claimed.

## Gallery

`/admin/design` is force-dynamic and mounts its client examples only after the
server's current `/v1/me` response explicitly returns `isAdmin === true`.
AdminShell is navigation, not an authorization gate. Failed, malformed, denied
or thrown checks leave the gallery unmounted; generic states have an h1 and a
Retry that refreshes the server route. Suspense announces the access check.
A local five-second race bounds authentication, token and response-body work,
aborts the fetch on timeout and clears its timer after settlement. A late
positive result cannot replace the returned unavailable fragment.

The gallery uses real primitive controls, overlays, validation, feedback,
loading and empty states with synthetic values. Sample saves and confirmations
change local preview state only. ThemeToggle uses the normal browser appearance
preference; Copy writes only on explicit activation and retains its manual
fallback when denied. The page performs no replay reads or API writes. Its
Operations navigation link reuses an existing icon.

## Ratchet and reviewed initial debt

The existing TypeScript parser supplies AST rules, with no new dependency.
Exact token-normalized file/rule signatures and occurrence counts prevent a
second copy or another file borrowing an allowance. New and stale signatures
fail; explicit pruning can only reduce debt. Static rules cover native
confirm/prompt, dialogs outside UI primitives, outline removal without a
positive-width ring, sub-12px arbitrary text, literal hex outside explicit
visualization paths, and hand-rolled link CTA patterns. `ring-0` is not a visible
focus replacement; a positive focus-visible ring alongside it is valid.

Initial integrated baseline: 574 signatures and 763 occurrences. No allowance
belongs to new primitive, focus/copy or gallery source. The NotificationBell
10px badge allowance is identical to main before its placement extraction.
Integration added only two individually reviewed initial-debt entries, both
byte-identical to the already-authored navigation branch: MacroBuildSelector's
programmatically focused editor group's `outline-none`, and ForecastExplanation's
custom modal role outside `components/ui`. No rule exception or path-wide waiver
was added for these. Their later migrations should remove those exact entries.
The rule does not interpret dynamic runtime CSS; normal review and browser
accessibility checks still apply. See `apps/web/scripts/ui-lint/README.md`.

## Verification

- Fifteen AST rule regressions pass, including duplicate allowance counts,
  lexical shadowing, non-color ID/URL fragments and zero-width rings. Final
  ratchet scan passes across 1,641 application source files with no new or stale
  allowances. Web CI runs the same command.
- The 36-file focused gallery/common-UI/notification/admin pack initially had
  200 passing checks and three expected integration failures: the older 16-link
  navigation assertion, missing per-segment layout metadata, and a gallery test
  selecting every validation alert rather than its request-error panel. All
  affected 30 checks pass after the repairs. Two added whole-request deadline
  cases also pass; final server access suite has 17 passing checks. This covers
  205 applicable checks without claiming a fresh full-web suite run.
- Full web types pass after the final deadline fix. All 43 owned source, unit,
  browser and rule-script files pass strict lint with zero warnings.
- Eighteen actual-source Chromium cases pass with one worker: six gallery cases
  across 360/768/1280 and both themes, plus twelve shared native focus/portal/
  sheet cases. Production Tailwind/global tokens and committed fonts are used.
  Every browser request is intercepted and clipboard access is explicitly
  denied; there are no unexpected requests or page errors. Gallery fixtures
  explicitly adapt Next navigation/images, Clerk, Help/report and Sentry; server
  authorization is proved separately by the server tests.
- Production Next build and all unchanged budgets pass. Required engine remains
  version1.6.12, content hash `fc21ebe5bf52a53c`. Gallery is dynamic, 181kB first
  load. Today234/240kB, game314.6/440, dossier454.1/500, overlay233.8/240,
  widget317.9/325 and Try238.2/240 all pass. No budgets were raised.
- Three additional owned viewport captures were inspected: mobile light
  controls, mobile dark right Sheet and desktop light controls. Text and actions
  are legible and contained. Browser/server work has stopped; logs and longer
  captures remain ignored under `apps/web/.cache` and `test-results/ui-primitives`.

No production data/provider changes, private admin evidence, migration, installer,
release, version or tag is part of this pack. Root still owns final commit,
current-main reconciliation, PR and exact-head CI/merge gates.
