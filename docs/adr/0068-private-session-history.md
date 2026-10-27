# ADR 0068: Derive private session history with explicit scope and consistency limits

Status: Accepted design; post-contrast local execution/manual review passed; exact-head release verification remains open.
Date: 2026-10-27.

## Context and decision

Reuse the shared replay-end session kernel introduced by [Sessions core PR
788](https://github.com/ReSpOnSeSC2/sc2tools/pull/788), merged as
`c0d16a1696866f4963f54b1a42a19c334213c10b`. Ordered duplicate members, unknown
result bridges and strict greater-than gap breaks remain its authority. A
calendar day, delivered game page or scan boundary must not invent a session.

Separate membership filters from the output day/window. Natural history uses
its selected cohort and ignores the current manual reset. Current uses the
fixed live 14-day, nonfuture, stats-visible/nonresumed universe and the latest
inclusive manual anchor. Resetting an empty current view cannot revive an
older pre-reset record. Activity selects a local output day, including actual
DST boundaries, without dividing a complete component at midnight.

Use one owner/date aggregate with indexed bounds, then a scalar BSON Date
guard, deterministic date/_id ordering and a fixed projection. Stream bounded
candidates, retaining ownership until cursor cleanup settles. Certify both
component edges using a neighboring break, full adjacent-gap coverage or an
explicit scope/as-of bound. Unproved or oversized views request explicit
context or a smaller supported window; withhold clipped summaries and cursors.

Unsigned versioned descriptors are bounded untrusted consistency locators,
not authorization, secrets or database snapshots. Obtain owner from auth and
re-derive policy/scope. Revalidate complete member content for reports and the
whole frozen-window digest for list continuation; relevant edits/late imports
require restart. Private no-store publication captures policy/privacy guards
before I/O and asserts them synchronously after the last await. This does not
introduce a global revision or snapshot protocol for ordinary post-read edits.
Authentication belongs to each of the three private Sessions GET routes so
unrelated routes keep their existing access policy.

Partition recorded ratings by exact own toon, strict queued race or unknown,
and rating scope. Only proved ranked 1v1 tracks with a supported queued race
receive a delta or connected curve. Other tracks keep raw values and sample,
legacy and missing cues. Never infer queued race from played race or invent a
pre-first rating. Missing values break the complete bounded curve; its raw
observation table and delivered game pages remain independent. Build labels
retain planned/detected provenance and unknown results retain honest denominators.

Fresh owner/path admission hides retired data and controls, including A→B→A.
Within a stable owner/report/cohort/context/current-mode/revision lifetime,
retain chart-open intent and explicit one-time Next-games focus intent only.
Fresh game pagination may focus the named games region with preventScroll;
modified links stay native. Retain no old payload or cursor for continuity.
The Today current-session card uses a Next dynamic boundary with its visible
loading slot, controlling entry bytes without raising route budgets.

Saved Views persist the Sessions list/cohort, never report locators, output
cursors or credential metadata. Keep patch-era membership with a removable
custom Game version chip and clear that predicate on explicit noncustom date
preset selection. A committed manual reset emits an authenticated owner-room
zero-count/zero-insert invalidation before optional overlay fanout, using the
existing refresh clock rather than creating replay counts or another socket.

## Bounds and physical query limitation

The admitted output is at most 31 elapsed days with up to 30 context days on
either side and a maximum 91-day envelope. Lists default to 20/max 50 sessions;
detail pages default to 50/max 100 games. Candidate limits are 5,000 normalized
rows plus one overflow sentinel, 2 MiB normalized bytes, cursor batch 32, Mongo
maxTimeMS 2,000 and a four-second caller deadline. Serialized private responses
also have a 2 MiB ceiling. Descriptors are at most 2,048 characters.

These limits do not bound physical keys/documents examined, raw wire bytes or
blocking sort work before returned rows. Actual local scalar explain is
2 keys/2 documents/2 rows with both date bounds. A Date-array multikey namespace
still examines 1,008 keys/1,008 documents for 3 rows with only an upper index
bound. The scalar guard keeps membership correct; that planner limitation is
unresolved. No hint, new index, migration, provider lookup, cache activation,
agent release, measured production saving or speedup is claimed.

## Accessibility and evidence boundary

A retained 38-case browser matrix passed on its captured pre-contrast source,
including native 200% browser zoom; 60 full AA scans reported zero automated
violations. Manual review still found 103 real Terran text labels at 2.55:1.
They are meaningful text and cannot be waived as decorative. The scoped table
RaceTag now uses existing theme-aware race tokens, with neutral unknown ink,
without changing chart palette output, unknown identity or strategy inference.
Four new palette cases measure actual foreground and opaque ancestor-composited
backgrounds for all races in both themes and responsive branches. The fresh
42-case Browser06 matrix passes with zero skips/retries/flaky cases and 64
full AA reports with zero automated violations. Its 16 contrast snapshots
retain 96 label observations; eight incomplete rule items/214 raw nodes are
preserved. Independent raw/source review classifies 206 aria-hidden map initials
and eight aria-hidden sort arrows as decorative; adjacent map text/header
aria-sort retain their information. No visible race label is incomplete.
All 96 normal/hover observations independently recompute exactly and meet 4.5:1:
minimum 4.7721:1 (light Zerg), light Terran 5.2056:1, dark Terran 6.2910:1.
Root reviewed palette, normal/native layouts, stale recovery and full-curve
paging captures. These bounded local findings are not product-wide AA
certification, production authentication or delivery acceptance.

Retain unsuccessful query, auth, preparation and browser-harness evidence.
The [history checkpoint](../handoff/sessions-history-checkpoint.md) distinguishes
old passes, the real manual contrast failure, its source correction, the fresh
build03/Browser06 execution and the remaining review/release gates. Existing optional cache flags
remain OFF. ADR 0067 and the shared-policy decision remain unchanged.

### Manual-reset publication fence (2026-10-27)

The policy/privacy lease alone does not retire a History request when GameDesk
changes the manual anchor: Games and History use separate resolver gates.
History therefore also captures a private owner-reset revision using the
existing bounded `OwnerRevisions` implementation. Actual GameDesk wiring
invalidates it before the anchor write and synchronously in `finally` after
that write attempt, including an error after durable commit. Service checks
and final HTTP publication assert both identities.

This adds no persisted revision, descriptor field, shared-cache invalidation
or natural-history membership rule. A held natural read can transiently
restart with 409; fresh natural summaries and locators remain unchanged.
Other owners retain independent revision identities.

Two original actual-route regressions reproduced stale HTTP 200. Four final
Express/Mongo cases pass current/current-detail reset races and the
write-commits-then-throws boundary. Fixture cleanup observes Mongo's close
event and fulfilled close promise; it does not drain buffered rows to force
the driver's `closed` getter. Broader API validation02 passes whole-API types, strict scoped lint, the
unchanged three-warning app baseline and 243 tests in 15 suites. New exact-head
CI after the API correction remains pending; earlier-head results do not accept it. See the checkpoint for retained
failed/superseded evidence and the separate browser/release boundaries.

### Preserve semantic presets across frozen session links (2026-10-27)

Generated Session links keep the user's semantic analyzer preset, including current_season, while a separate versioned Session-only transport freezes membership. sessionScope=1 carries optional scopeSince/scopeUntil/scopePatch; API builders map only those bounds back to since/until/patch_era and strip the UI transport. Under a marked frozen scope, absent bounds mean unbounded membership, not fallback to the UI's resolved dates. Unknown versions/prefixes, duplicates, invalid/reversed ISO bounds, patch values and refresh flags fail closed before requests.

Reports, continuations and explicit output day/windows retain their exact snapshot while the semantic cohort stays unchanged. A bare latest list recaptures actual resolved Auto-season/catalog boundaries; an explicit cohort change retires cursors and captures new bounds. List Refresh/recovery uses strict scopeRefresh=1 to request recapture without losing generated-link identity; the real query helper consumes it before fetching. Same-key Refresh/recovery must explicitly revalidate. Report Refresh continues to check the exact descriptor and content.

Generated same-cohort admission is limited to Session paths, including initial reload and the current report. It does not turn on copied-view storage suppression and never clears a pre-existing copied-view lifetime. Generic explicit Custom/copied/saved-view URLs without the marker retain their prior behavior; non-Session routes never gain this admission exception. Saved Views persist semantic filter allowlists, not frozen transport fields. No global Custom reset or migration is used to guess a legacy URL's intent.

Local integrated verification passes whole-web types, strict lint on nine changed files and 300 tests in 35 files, with 43 observed identities closed. New coverage includes nine real shared-provider journeys and 21 pure transport/URL tests. The final local production build passes all83 original caps (/app239.8/240 kB). Four390/1280 light/dark browser documents pass32 raw AA scans with zero violations,1,778 measured contrast labels and only four decorative aria-hidden map/sort incomplete nodes; source and assets match. Exact-head CI and delivery remain separate pending gates. This client fix changes neither the session kernel/API query rules nor the previously documented physical scan limitation; no index, provider activation, cache flag or agent release is introduced.