# ADR0049: Account assignments for Ghost practice

Status: accepted for implementation (`ghost-synced-practice`).

The existing `preferences.ghostBuilds` reference/history service keeps its
250-step replay contract. Active website/OBS assignments use a separate
`preferences.ghost` v2 configuration: nine exact matchups, at most 80 steps per
target and 64KiB of expanded UTF-8 JSON. The API and web validators share JSON
parity fixtures. Legacy compact fragments retain their separate encoded bound.

An owner-indexed preference GET and explicit PUT/PATCH reuse the existing API.
Practice actions patch one slot with a bounded three-attempt compare-and-swap;
browser migration fills only empty account slots. Undo/disarm can also compare
the observed target, so an old action cannot erase another device's newer edit.
No collection, index, worker, provider request or new infrastructure is needed.

Each existing preference write also increments `preferences.ghostRevision`.
HTTP and socket snapshots include that sequence. The overlay, account cache and
SWR consumers reject lower revisions, including held bootstrap/resync responses
that arrive after a newer save broadcast. Owner notification markers coalesce
at most 64 in-flight owners; a new same-owner save always replaces its marker.
Only that owner's active, non-pending overlay token rooms receive targets.
The existing private user room gets a boolean refresh advisory. The current
backup allowlist preserves both Ghost fields; restoring an old snapshot cannot
roll the live assignment or sequence backward.

Missing account configuration preserves old URL behavior. A present empty
configuration explicitly disarms and overrides old URL assignments. Browser
data moves only through an explicit owner-specific migration; an unscoped old
localStorage value is never another account's offline fallback. Account caches
are keyed by owner. Authentication, cancellation and actual deadlines surround
token lookup, response bodies and save acknowledgement boundaries.
Reads also carry an owner epoch, so an A→B→A transition cannot reuse a held
token lookup or response body from the first A session.

Practice uses a saved private build's reference first, then its owned source
replay, then positive rule deadlines as labelled checkpoints. Public snapshots
cannot name a private source replay or select an unrelated same-slug private
reference. A source replay must match the chosen own race even when a saved
definition was edited after capture. Published guides reuse their recorded
community medians. Negative,
maximum-count and proxy-location constraints do not become produced steps;
cumulative count rules do not invent duplicate production. Native Companion
assignments and its assistance opt-in remain separate.

Practice actions, replay grading/reference controls and the app chip load their
larger code lazily, with bounded chunk loading and local retry. The preference
transport is framework-free to preserve server-guide bundle boundaries. A
build-card render starts no per-card reference lookup or provider fan-out. OBS source URLs
remain permanent across assignment edits. The separate URL voice opt-in still
requires a new URL when that switch changes. No production operation or desktop
release is part of this implementation.
