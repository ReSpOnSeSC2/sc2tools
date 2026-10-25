# Opponents list and rivals checkpoint

Branch: `codex/wave3-opponents-rivals`, based on merged Strength #713 (`8369fc50`).

## Scope and preserved behavior

Implements the remaining `opponents-list-mobile-rivals` plan and augments. The
existing notes, URL/persistent sorting, real dossier links, delayed prefetch,
request recovery and browser Back restoration remain. Earlier source branches
for Strength, Mechanics, Story and stream titles are preserved.

## Foundation (in progress)

- Shared Wilson rivalry selection and one 100-row render window, including
  expanded identities; Show 100 more; restored 200/400-row windows still work.
- Desktop race/region, sticky names and persisted column overrides; phone cards
  use the same links, sort state, logical window and 44px actions.
- Owner-scoped max-50 star preferences with token/response fences; distinct
  Regulars, Played this week, Lost to most and Rivals controls.
- All matching list rows export through `lib/csvExport.ts`: BOM, CRLF/RFC4180,
  string formula guard, measured negative numbers unchanged, scope/export time,
  merged account IDs and honest notes-preview heading. Partial lists cannot
  masquerade as complete exports.
- One optional owner-scoped slim-game facet provides recent counts (2,000
  account sentinel) and at most 20 scalar samples per starred group, across at
  most 500 owned accounts. Four admitted reads, 256-entry/60-second cache and
  owner invalidation fences; all three replay visibility markers are excluded.
- Pulse movement uses raw history before downsampling, real observations near
  each 30-day boundary, the existing read-only client, six-hour/512-entry cache
  and two global cold admissions. Excess/missing data remains unknown.
- Live badges use only fresh public viewer-cache observations and cached public
  channel aliases; list requests do not start live-status provider traffic.
- Cheap owner-checked dossier star-key route/component is prepared. Header and
  overlay integration, shared dossier replay CSV, Help and final evidence remain.

## Local evidence so far

- 45 focused web tests, including 1,500 rows (100 then 200), previous Back
  restoration, owner/token/response fences, Wilson bounds and CSV cells.
- 27 focused API tests with temporary MongoDB and mocked providers, covering
  visibility/owner/filter scope, top-20 lower-bound streaks, recent cap,
  generation invalidation, raw rating history, cache TTL/admission and cache-only
  live status.
- API/web typechecks and strict scoped lint pass for the foundation.

## Integration / remaining work

Integrate frozen Dossier #714 and replay-library-control before final gates,
preserving shared visibility invalidators, installed-native compatibility and
the replay CSV serializer/admission. Extend that existing export primitive for
the dossier's trusted owner/opponent/sample scope and 5,000-row cap; do not add
an independent serializer or admission policy. Finish consumer/owner tests,
Help/changelog, responsive local-browser evidence and unchanged-budget build.
No production job, migration, real account write or provider operation was run.
