# Public player page checkpoint

Root's final repository scan also found the existing guides no-PII fixture
still expecting UUID profile discovery from the retired Community sitemap.
Its assertion now requires the intentional empty profiles array. All three
no-PII checks and strict lint for that test pass. This is a test/documentation
follow-up only; the validated web build and runtime inputs are unchanged.

2026-10-25, `codex/wave5-public-player` in `.worktrees/wave3-my-reviews`.
Parent owns API changes; web source work is delegated to `public_web`.

## Source contract

- Canonical `/players/[player]` shows only permitted Overview, Builds, Replays
  and Reviews links. Existing `/players/.../replays` and analysis paths remain.
  Legacy profile/author and replay paths resolve the authoritative canonical
  address before a permanent redirect, preserving replay filters.
- Explicit profile Off overrides grandfathered named publications. Replay
  sharing is independent. No new optional section starts on for a legacy user.
  Community author chips use only fresh public capabilities, never owner IDs.
- Owner-keyed settings use the shared API ownership/deadline contract, versioned
  saves, debounced scoped availability and visible feedback. Creation assigns
  only an address while private; prefix edits preserve the suffix and respect
  the active-archive guard and 30-day cooldown.
  Publication writes require Clerk browser authentication; a paired desktop
  credential can read its owner's settings but cannot grant public consent.
- Public page/metadata/image admission is fresh and no-store, with request-only
  memoization. This intentionally replaces planned ISR300/CDN3600 caching for
  privacy. Aggregate and bitmap caches sit behind fresh admission; image cache
  is bounded to48 entries/8MiB and one hour. See ADR0065.
- Public recent form is optional and identity-free, oldest-first in the UI,
  with at least three rows, sample summary, streak from two and en-US relative
  last-played copy. Map/season/MMR/channel sections remain independently gated.
- Both canonical and legacy public signature-build readers request the shared
  detector view. Private planned check-in names/counts stay in owner analytics;
  deliberately published Community build content keeps its separate visibility.
- Channel panel and OG use selected public fields only; all unavailable,
  disabled and archive-only profiles produce neutral image data. Record/build/
  MMR styles support320×100 and320×160 in either theme. Shared CopyButton handles
  clipboard deadlines and visible fallback; no native prompt is added.
- Help, a sixth Stream Studio lesson, changelog and fresh sitemap contribution
  accompany the feature. Sitemap route admission is dynamic with no output
  cache; unrelated list data retain their existing bounded caches. Deprecated
  UUID profile URLs leave the sitemap.

## API verification

- Full API types pass. Eleven new runtime/test files pass strict lint with zero
  warnings. Two long Jest registration callbacks have narrow, explained
  registration-only suppressions; new runtime functions need none.
- The affected API pack passes260 tests in16 suites and one snapshot: privacy,
  real Mongo CAS/unique index, legacy address repair, recent-form allowlist,
  current consent before warm caches, canonical sitemap, archive aliases,
  Community, summaries/builds, reviewer reputation, seasons and backup consumers.
- The subsequent Clerk-only write hardening passes59 focused checks in3 suites,
  then full API types and the same strict lint pass again. Device/agent writes
  receive403 without a preference write; Clerk writes and owner reads work.
- The detector-view hardening passes191 checks in14 affected profile/build-intent
  suites and one snapshot. Real Mongo rows use three detected replays and one
  unknown detector, each overridden with the same private check-in. Public
  signatures contain only the detected label, unknown never falls back to the
  private plan, and owner build counts still use the plan. Published build
  content remains unchanged before and after Profile Off. API types and strict
  new-file lint pass; the changed legacy files have only the existing
  `builds.detail` max-lines warning. Its initial new-fixture setup failure was
  a missing required Community slug secret; a synthetic test secret fixed it.
- Live section flags and the canonical address also participate directly in
  the bounded cache key, alongside revision/updatedAt. Seven focused regressions
  first reproduced stale responses when each section turned Off or the address
  changed without a revision bump. All66 checks in the three affected privacy,
  real-Mongo preferences and route suites pass after the fix, as do API types
  and strict changed-file lint. Fresh admission therefore does not depend on
  a version-bump assumption for optional-section privacy or canonical links.
- A final review found Community DTOs could cache a decorated profile link
  after Profile Off when the optional purge failed. Decorated list, detail and
  Arcade responses now use no-store admission; the author endpoint already did.
  A warm shared-response regression first failed, then passed with the repair.
  The final affected API pack passes130 checks in6 suites; types and strict
  changed pure-helper/sitemap-test lint pass. Six inherited large-function and
  suite-registration lint warnings remain in the touched legacy files.
  The old Community sitemap retains cached published builds and intentionally
  returns profiles:[]; an additive service option skips its unused legacy UUID
  aggregation. A real Mongo regression proves one build query, no UUID discovery
  for an explicitly private named publisher, and unchanged public build content.
  Canonical player discovery keeps its separate fresh privacy gate.
- Initial Jest stopped before fixtures on a Windows temporary-cache rename
  restriction (zero tests). A writable workspace cache and reviewed local
  Mongo runtime resolved that environment issue.
- The first consumer pack had four failures: two legacy public-content fixtures
  omitted their synthetic account rows, one expected shared caching for an
  author admission response, and one sitemap fixture violated the existing
  Clerk-id unique index. Valid account fixtures, fresh-admission expectations
  and unique synthetic ids fixed those cases. The81-check affected rerun and
  final260-check pack pass. Unknown/orphan profile admission remains fail-closed;
  a regression proves an individual published build stays public without an
  orphan author/player profile or profile link.
- Existing whole-file API lint guidance remains in large legacy functions in
  app.js, community/publicReplays routers, aggregations/builds/community/users/
  userBackups services, plus the pre-existing unused `_g`/`_r` aggregate bindings.
  New files are strict-clean; no whole-owned-files zero-warning claim is made.
- Logs are in `apps/api/.cache/public-player-*`. No generated map-pool fixture
  diff or production operation resulted from validation.

## Web verification

- Shared UI/A11y and 0.24.7 release parents are integrated. Final checked HEAD is
  `2f97a948954f1a6f158dca474d1ff6a3272e0665`, with the reviewed pending feature
  fixes. The ancestry merge changed only three handoff documents; root verified
  all 3,221 web-file hashes against the successful replacement build inputs.
  Later changes were test fixtures/assertions and a relative test import only.
- Whole web types pass against regenerated route-group types. Strict changed
  source, units and browser fixtures pass without warnings. UI ratchet passes
  1,660 source files/734 existing occurrences, with no new or stale allowances.
  Sixteen retired allowances were pruned from `scripts/ui-lint/baseline.json`;
  none were added. Help generation succeeds with 89 articles; its generated
  index has a stat/line-ending-only working change and no content diff.
- The expanded focused pack passes 389 tests in 57 suites at two workers.
  Subsequent route-group checks pass 17 tests in three suites, and the existing
  route-loader consumer passes four tests after its relative import update.
  Coverage includes warm-cache/failed-purge author-capability removal, fresh
  metadata/errors, optional-section boundaries, owner and slug A→B→A retirement,
  deadlines, Help drift and real PNG rendering. All panel styles render real
  320×100/160 images in both themes; Community OG renders a real 1200×630 PNG
  with no-store even when optional purge is configured.
- A real availability render loop was found: the shared owner-request closure
  changes identity on renders. Availability now snapshots it through a ref
  while retaining owner/slug/needed/attempt retirement and request cleanup.
  Held old A/B answers cannot unlock Save for a newer A. Stale lesson/card
  fixture expectations were updated to the new public-capability contract.
- The isolated browser settings fixture passes two cases at one worker using
  actual components, ownership helpers, CSS/fonts and synthetic intercepted
  requests. All eight 320/390/768/1440 light/dark views fit. Clipboard denial
  gives a visible selected fallback with Escape focus restoration; a held
  save cannot complete into a later A→B→A account.
- Final built-server HTTP/browser checks pass 17 cases; four nonmobile
  Download-command cases intentionally skip because that regression runs once
  per theme at 360px. The three projects cover 360/768/1280px, both profile
  themes, profile Off, neutral panel bytes, Community link Off without purge,
  exact legacy 308/private404/temporary500, directory loading and Download
  keyboard scrolling/axe. A strengthened three-project rerun also proves the
  fresh Off Community HTML/RSC body contains no author-profile URL.
- The first artifact exposed a real streamed200 on the legacy Community author
  redirect. Its leaf loader was removed; the original Community index loader
  moved with the page/test into `(directory)` so it cannot wrap author routes.
  Final HTTP checks prove both the directory's visible loading→content flow
  and correct author statuses. Child build/opponent skeletons are unchanged.
- The root-authorized replacement production build passes compilation, full
  type validation, 143 static pages and tracing. Direct Next build reused the
  warmed engine assets; no duplicate engine compilation or install ran. The
  initial sandbox mkdir EPERM was resolved with reviewed host access. Existing
  whole-repository lint warnings remain; strict owned source is clean. All 18
  named and 63 default bundle budgets pass without a budget change.
- Browser launch uses existing pinned Chromium1228 with reviewed host access;
  no browser was installed. Initial missing sandbox-cache/startup failures
  were environmental. A test-only selector initially matched visible and hidden
  streamed spans; its visible-content assertion was corrected, while raw body
  exclusion independently proves no hidden capability remains.
- Preserved logs: `.cache/public-player-final-build.log`,
  `public-player-final-http.log` (initial locator RED),
  `public-player-final-http-green.log`, `public-player-raw-off-http.log` and
  `public-player-visual-http.log`. Clean phone light/dark and desktop screenshots
  were visually inspected in `.cache/public-player-visual-artifacts/`; settings
  evidence remains in `.cache/public-player-browser-artifacts/`. No clipping or
  body overflow was observed. All test servers and runtime jobs are closed.

## Delivery boundary

Source is frozen for root-owned preservation/review and exact-head CI. No
production account, publication switch, replay, provider or data migration was
changed by this workstream. No Git commit, push or deployment was performed by
the delegated web worker.
