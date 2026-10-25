# 63. Saved opponent columns with bounded private summaries

Date: 2026-10-25

Status: accepted

## Context

The opponent table needs replay download, latest builds/map/result/duration,
macro links and measured averages without hydrating every opponent's game
details. Existing saved column choices were overwritten by the first default
render in React StrictMode; a later visit restored the defaults.

## Decision

Keep column choices in the existing browser-local preference key. Hydration is
read-only; explicit changes write synchronously before leaving the page. Reset
is an explicit saved choice. The picker describes automatic saving and shares
the choices with phone detail cards. Older valid preferences remain usable as
new columns are added. This is a browser preference, not account/cloud sync.

Request `listDetails=1` only when a summary column or summary-based sort needs
it. Region and notes alone use existing fields. Add bounded scalar projections
to the existing page-scoped batch reads; preserve the cohort, owner, visibility,
resumed-game and deletion guards. No request per row, detail-blob hydration,
R2 list reads or GET-time metadata writes. The default list keeps its existing
read path. Duration and macro averages use measured sums/counts across the
matching games, including weighted sums when aliases are grouped. Missing
measurements remain distinct from zero.

Build labels do not establish whether a recorded opponent build log exists.
Availability comes from a compact fact written beside the actual game details,
using existing atomic Mongo writes or the existing R2 metadata revision fence.
Inspect at most 25 recent candidates per returned opponent and 5,000 per page.
Older/legacy candidates, incomplete windows and R2 metadata cannot prove a
complete absence or the current state of every blob. Qualify positive dates
as **Latest known** and offer inspection; show unknown dates without inventing
one. Complete coverage may establish a known result only when the active
details backend is confirmed Mongo and every candidate has an atomic source
fact. A Mongo-looking row alone is insufficient during an R2 cutover whose
first metadata acknowledgement fails. No
production backfill is required or executed for this change.

Replay downloads use the existing authorized route only after a click. Bind
JWT acquisition, response parsing and delivery to the current owner and replay
source; cancel stale/ABA operations and bound the wait. Rendering the column
does not request a token, signed URL or replay. Links to macro/build details
retain opponent/list navigation context. CSV extends only scalar fields and
uses the existing formula escaping; it never contains signed URLs or full logs.

## Consequences

Users can keep a compact table or select additional detail without losing the
choice between visits in the same browser. More detail can add width, so desktop
scrolling stays within the table and phones use labelled cards. Metadata gaps
remain visible instead of presenting a guessed build-order date. Shared storage
and download changes need actual consumer tests beyond the opponent table.

Validation and final implementation details belong in the accompanying handoff
checkpoint and pull request. Infrastructure, bundle budgets and deployment
settings remain unchanged.
