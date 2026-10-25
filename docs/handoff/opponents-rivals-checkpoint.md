# Opponents list and rivals checkpoint

Branch: `codex/wave3-opponents-rivals`, based on merged Strength #713 (`8369fc50`).

## Scope and preserved behavior

Implements the remaining `opponents-list-mobile-rivals` plan and augments. The
existing notes, URL/persistent sorting, real dossier links, delayed prefetch,
request recovery and browser Back restoration remain. Earlier source branches
for Strength, Mechanics, Story and stream titles are preserved.

## Implemented

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
- Cheap owner-checked dossier star-key route/component is integrated in the
  header. Matched stars set the overlay's explicit RIVAL tag below the former
  three-meeting threshold; display-name-only fallback cannot attach a star.
- Dossier CSV uses the existing replay serializer and the same account limiter
  and streaming loop as the library. Paging and export share one owned history
  scope, including linked identities, global/local filters and explicit analyzed
  sample membership; the dossier cap is 5,000 newest matching rows.
- Removed the unimported old `components/OpponentsList.tsx`; repository search
  leaves only the unrelated admin response type. Strategies' nested height cap
  now applies on desktop only. Help and its generated index are updated.

## Local evidence so far

- 191 focused web/Help tests, including 1,500 rows (100 then 200), previous Back
  restoration, owner/token/response fences, Wilson bounds and CSV cells.
- 163 focused API tests with temporary MongoDB and mocked providers, covering
  visibility/owner/filter scope, top-20 lower-bound streaks, recent cap,
  generation invalidation, raw rating history, cache TTL/admission and cache-only
  live status, existing dossier/overlay consumers, scoped CSV parity, empty and
  malformed analysis samples, 5,001→5,000 truncation, canonical/lowercase account
  parity and shared route admission.
- API/web typechecks and strict scoped lint pass for the foundation.
- Required-engine integrated production build and every unchanged bundle budget
  passed: Today 227.3/240 kB, game 316.7/440, list 120/180, dossier 475.5/500,
  overlay 233.9/240. Existing giant-file/hook warnings remain baseline warnings.
- 79 local browser assertions at 320/390/768/1440 in light/dark, with actual
  consumers and production CSS/fonts. Captures live under
  `docs/handoff/screenshots/opponents-{list,rivals}-{theme}-{width}.png`.
  Long-name grid overflow found there was corrected. Providers/nonlocal traffic
  are blocked; the only writes were synthetic local star preferences.

## Integration / remaining work

Frozen Dossier #714 and replay-library #716 (`fb528645`) integrated cleanly at
`b7b52b8b`; the final account-case follow-up (`cd44666a`) then integrated at
`f07298b9`. Fresh main #716 (`4a1e95a8`) was reconciled at `343a94c8`: its
apps/changelog tree was proven identical to the already integrated dependency,
and conflict resolution left the tested source tree byte-identical. Installed
native compatibility, visibility markers and all existing cache invalidators
are retained. Game-control changes also invalidate Rivals with an admitted-read
fence. Root and independent reviews accepted API/CSV ownership and scope; the
independent hook review is also clear after the fixes below. Final production
build/budgets and 79 browser assertions were rerun on that reviewed source.
Final CI/PR/merge evidence will be appended after the expected head is green.
Independent review found and corrected two client boundaries before first CI:
all auth fields now define owner scope, including loading/signout with a stale
same user ID; a real deadline/cancellation race settles held token/body promises
and allows retry. Fifteen deterministic tests cover these paths and late
settlement, including a held cache mutation; active controller identity also
fences return-to-same-owner races. The initial preference read uses the existing
API deadline too, with explicit retry recovery.
Design decisions and flat-resource limits are recorded in ADR 0038.
No production job, migration, real account write or provider operation was run.
