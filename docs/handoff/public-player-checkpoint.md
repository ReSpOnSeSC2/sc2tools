# Public player page checkpoint

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

## Web and delivery verification still required

No web tests, types, lint, build or browser jobs were run during source delegation.
Shared UI/A11y integration is required before the new CopyButton leaf import
resolves. Added contract tests cover
fresh admission/temporary failures, single-hop aliases, optional sections,
capability-only author links, owner/ABA/deadline settings and real PNG rendering.
Existing profile, replay, metadata, sitemap and lesson fixtures are being updated
for the final contract. Final current-main integration and full exact-head CI
remain root-owned gates. No production account, visibility switch, replay,
provider, installer or data migration was changed during implementation.
