# Analyzer section URL navigation

Status: accepted, 2026-10-25.

Global filter and section edits share one bounded client query transport.
Pending owned router acknowledgements compose instead of overwriting newer
input. Browser/epoch checks fence delayed writes across Back, Forward, external
navigation and same-address revisits. The singleton is never mutated on SSR.
Section keys are disjoint from the global-filter serializer; copy links include
only the known section keys and the validated global snapshot, excluding tokens
and unrelated query state.

Text q has an immediate input draft and a committed URL value after300ms.
Replay API requests use committed cohorts and batch cursor clearing with edits.
Owner/cohort session cursor memory is bounded to12 histories/64cursors and250kB.
Without it a saved page offers Back to newest. Existing replay visibility,
selection, export, source/backlink and owner guards remain in force.

Strategy sheets push one entry, retain both axes and a local matchup in one
drill value, and use Back only for entries owned by this browser session. Next
replaces custom history state; the shared writer carries a narrow bounded marker
through owned acknowledgements only, checking the actual browser address before
restoring it. Direct/copied entries close with replace. Existing global filters
stay authoritative. Other section controls use replace and device fallbacks.

Daily Pulse links carry their build/map/opponent context and applicable global
filters. Its corpus remains explicitly loaded; its carousel observes visible
position and respects keyboard input and reduced motion. No new endpoint,
infrastructure, background work, integration enabling or AI call is introduced.
