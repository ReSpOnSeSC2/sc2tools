# Dossier upgrade — PR A: brief and layout

The `dossier-upgrade` plan is split into its specified two PRs. This first pack supplies brief, series, navigation, scope and identity/ladder layout. PR B owns the cheap default endpoint, explicit bounded analysis endpoint, lazy timings/phases/transitions and sampled timing history membership. The isolated KeyTimings component/types are prepared here but remain unmounted until that contract lands; PR B adds the Timings navigation item.

## Source and bounds

- A pure six-line brief uses the supplied owner history, explicit counts and at least two decided games for a build pairing. Its existing grudge templates stay deterministic. Missing facts are omitted; phase information is used only when already supplied. Copy/fallback completion is fenced to the current brief.
- A compact all-time series reuses the existing owner/identity-scoped metadata query. It adds no detail reads. First/last dates come from opponent documents, taking linked min/max dates. Up to1,000 newest slim result rows carry a sentinel truncation flag; sampled best/current bounds are explicit. The last ten decided results run oldest-to-newest left-to-right and link to games.
- H2H charts precede map/strategy rows, predictions and history. The duplicate tendencies card is removed, and strategy share appears with its observed decided count. Map/strategy buttons retain their shared filters and active highlight.
- Replay history remains immediately above notes. Sticky section navigation reuses SectionNav's scroll spy, hash and aria-current behavior. One h1 belongs to the opponent; sections are h2 and their cards h3.
- Show all time removes only this dossier's date/patch window and resets on opponent navigation. It never changes analyzer filters. Empty scoped results with recorded history offer the last meeting date and recovery.
- Identity panels are lazy inside one disclosure. Unrevealed barcodes and unresolved accounts auto-open it; diagnostics opens automatically only for unresolved account identity, or through Data looks wrong. Ordinary identity forms remain collapsed until requested. Ladder context is revealed on approach and contains its race sub-table.
- Busy admission retries four times with1/2/4/8-second delays, waits for each in-flight attempt, and cancels scheduled work on scope changes/unmount. Ordinary network failures keep manual Retry;404 says Not in your history. Community profile appears only from cached communityAvailable.

## Validation and continuation

The initial series/linked/scope/privacy/memory proof passes13 API assertions and full API types. Pure/isolated component slice passes53 assertions. Root integration types and strict changed-source lint pass; final state/identity/notes/candidate/Help consumer batch passes84 assertions. Required production build, final browser screenshots and expected-head CI remain gates before merge.

The required production build and every unchanged budget pass (landing214.2/215, opponent472.8/500 kB). Late review fixes add explicit owner-key resets/auth guards and abort/token/late-response fencing for identity drafts (13 actual-network-boundary regressions), and reuse the confirmed header's authoritative ladder response after delayed section reveal (2 real-SWR request-count tests). A positioned native table scroller fixes hidden-status overflow while preserving horizontal scrolling and game actions. Replay sources now carry the displayed local date/map/strategy/build/result cohort, including explicit replacement of incoming URL dates;39 navigation/history/map-modal/table checks pass. Root's final boundary batch passes67 assertions. Browser106 checks pass before the last tablet header breakpoint correction; final captures and expected-head CI remain the merge gate.

Preserve the original playback branch in this reused worktree. API B is separately committed on `codex/wave3-dossier-analysis` at2d1983dd and must be integrated after A without losing series metadata. No production operation, new infrastructure, credentials, job, index or migration is required by A.
