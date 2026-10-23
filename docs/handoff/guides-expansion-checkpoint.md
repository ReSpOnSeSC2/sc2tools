# Wave 3 guide expansion checkpoint

Branch: `codex/wave3-guides-expansion`. Implements `guides-expansion-1`,
`guides-expansion-2` and `guides-expansion-3` from `plan/final-plan.json`.
Their augments are empty; the five audit concerns and all how-to
requirements are included. Main `441582d0` is integrated, including the
default rail/bar SectionNav and public-only mechanics override from #688.
Implementation checkpoints are `5b9290e8` and `86bce298`; the PR records
the final evidence commit. No shared focus, filter, chrome or SortableTh edits.

## Scope

- Openers retain their supplied Wilson-bound rank on the server. Search
  ignores case/accents; local sorts never change the canonical URL or the
  printed rank. Published-only filtering is absent/ignored on the 8-worker
  view. Phone cards expose the same rows and a sort picker; popularity
  movement uses the existing flat threshold.
- Build matchup rows are grouped by the existing likely-range verdict.
  Favoured is open; other groups reveal beyond five rows. Win-rate/game
  sorts stay within their group. Best/toughest map cards remain, with a
  complete sortable native disclosure above six maps and published-link gating.
- The community timing table remains server-rendered. Once auth resolves
  signed in, lazy private islands share the existing account-scoped SWR
  key. A pinned You column carries median deltas, accessible explanations,
  small-sample notes and missing-sample dashes. Unresolved/signed-out/401
  states never show private numbers. Retry and the build-library link are
  available; the duplicate timing list is omitted when the table is present.
- Counter lists show aggregate win rates, rank toughest by interval ceiling,
  search/sort locally and retain the old published-first order without new
  stats. Matchup previews contain at most six published counters.
- Map guides keep their gallery and can switch to a remembered table with
  search, null-last column sorts and two columns for a selected race.
  Storage failure retains a usable gallery and allows this tab's explicit choice.
- The build-guides help leaf covers sorting, personal comparison, counter
  perspective, matchup groups and the map pool. No route loading boundary
  or HTTP status contract was weakened.

## Contracts for later work

- `lib/guides/timingDelta.ts` is pure. p25/p75 are inclusive; outside the
  middle half is early/late; missing bounds produce a neutral median-only
  delta. `lib/guides/useGuideMe.ts` shares the authenticated private key.
- The nightly map doc now stores compact cells without opener payloads.
  Its internal users count exists only to recheck the cell floor. The
  existing index query projects that field; no new query or aggregation is
  added. Public `maps[].cells` has only `matchup`, `games`, `winRate`, `ci`:
  at most one of each of the six non-mirrors. Missing older fields fall
  back to the gallery until a normal nightly recomputation.
- Counter docs gain users/rate/interval; serve-time shaping rechecks both
  count floors, finite unit-range values and ordered intervals. Public
  counter links expose only rate/interval alongside their existing fields.
- These are aggregate-only additions. The API review and real no-PII scan
  confirm that identities and raw rows cannot enter either public projection.
  The map-veto planner can consume index `maps[].cells` from one cached request.

## Verification

CI follow-up: the existing nightly and route assertions now verify the exact
new counter/map payloads, including privacy-safe keys and null rates below
the publication floor (45 real-Mongo assertions in the two previously failing
suites). The old phone headline smoke now checks the ranked cards shown on
phones. Definitions filtering remains local and now replaces browser history
without an RSC request, so a delayed server response cannot hide a newer hash
target; rendered and repeated production hash/focus regressions cover this.
Shipped main `71d00337` (#693 shared clock/phone HUD and #694 share previews)
was integrated; only CHANGELOG conflicted and both entries were retained.

- 481 web assertions / 55 files: guide components, helpers, routes and all
  help tests. Includes real SWR request deduplication and auth gating.
- 41 API assertions / 3 suites: guidesPayloads, guideStatsIndex,
  guidesNoPii. Real nightly 20,000-game + 10,000-sample recomputation took
  2.76 s in the final run; indexed query plans and scale budget passed.
- Full web/API typechecks; strict scoped web/API lint; clean diff check.
- Exact-CI production build and every unchanged budget pass. Guide entry
  is 167.6/175 kB after private comparison code was deferred until sign-in.
- 31 Chromium checks pass, two deliberate duplicate no-JavaScript skips:
  16 feature checks plus 15 existing 404/308/ISR/outage-cache checks.
  They use real production routes at phone/tablet/desktop widths, plus
  actual personal-island fixtures with explicit synthetic auth/data.
  No-JavaScript ranks, matchup tables and native all-map disclosure pass.
- Five inspected screenshots are under `screenshots/guides-*.png`.

No new environment variables, migration, infrastructure or production
mutation. The ordinary nightly stats run populates additive fields;
older web/API versions ignore them. Rollback is a normal PR revert.
No AI features or AI API calls were added.
