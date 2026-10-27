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