# Macro graph inspection stays in place — 2026-10-26

The owner reported that selecting a point in the full game Macro graph scrolled
to the replay map. MacroChartSection emitted the same seek callback used by
explicit Watch replay actions. The shared clock's default reveal behavior
scrolls to an offscreen player and focuses it.

GameMacroSection now accepts a distinct `onInspectTime` callback for its graph.
GameDetailPage supplies a stable callback using `clock.seek(time, { reveal:
false })`. Time, seek request, chart selection, rosters and the timestamp URL
continue to update; graph inspection leaves page position/focus in place.
Timestamped leaks and explicit replay/story/build/report actions retain their
existing reveal behavior. No global clock or graph interaction change.

The actual full-page regression selects two different graph points using mouse
and touch events, checks the mounted clock and both rosters, and checks that
the offscreen player was neither scrolled nor focused. A subsequent actual
macro-leak action must reveal the player. The hook regression independently
checks repeated no-reveal seeks with an offscreen DOM stage, focus retention,
unchanged source/hash and `scroll:false` timestamp navigation.

Validation together with the separate Auto-season default correction:

- 202 focused tests / 15 suites; 35 Help tests / three suites.
- Whole-web types before/after build, strict changed-file lint zero warnings;
  UI rules 19/19 and ratchet clean, 1,699 files/642 existing entries.
- Build `XRIBFiZxEZrYKi-dSwZtl`: 144 pages/all 81 route budgets passed, including
  game page 314.7/440 kB. The build preceded the final game-page Help wording
  and updated-date edit; exact-head CI must compile that final wording.
- Help index: 91 articles, deterministic/unchanged. Canonical 40 engine inputs,
  d27 bundle, four sample payloads and nine retained files unchanged, with no
  generation/download/copy/pruning.

Local evidence is retained in `.cache/analyzer-behavior-fix/` in the
`wave3-guides-expansion` worktree. Real browser scroll proof and exact-head CI
remain pending at this source checkpoint. No actual account/API writes,
reanalysis, native-agent launch, version bump or release tag.

## Native browser proof and accessible statistics

The first four native phone selections preserved focus identity and scrollY,
but the full-page accessibility scan exposed inherited Mechanics description
list nesting. MechanicsPanel now uses two valid lists with the same spacing,
grid classes, values and callbacks. Its actual-render semantic regression and
all prior assertions pass: 66 affected tests/five suites, whole-web types and
strict two-file lint zero warnings. Original source/hash and the AA failure
are retained in the cache; no accessibility rule was excluded.

Final strict loopback browser proof in `graph-final-evidence/` passes 148 checks:
16 native mouse/touch selections at 360/1280 in both themes preserve focus and
viewport position while updating the exact delivered clock, both prior-sample
rosters and URL. All four explicit leak actions still reveal/focus replay.
Auto/custom/Reset persistence passes. Eight full WCAG scans have zero
violations; 12 screenshots are retained, with two reviewed byte-identical
copies tracked. All 216 GETs are classified; 20 exact expected map/sprite
404s use existing fallbacks. Zero unknown/rejected/nonlocal requests, page
errors, writes or actual account/provider operations. Server59363 is closed
and not listening; follow-up listener inventory is empty.

Cache-only first-run repairs preserved their original bytes/logs/captures:
explicit UTF-8 transport, native pixel-derived clock expectations, recorded
prior-sample roster labels, and source-backed exact DTO/static contracts.
No clock/roster/focus/scroll or accessibility assertion was relaxed. No
runtime asset was generated or downloaded. CSS/fonts come from build XRIB;
the fixture bundles the current actual components. Final exact-head CI must
compile the final Help wording and Mechanics tags before merge. Vercel rejected
one normal exact-ref graph Preview at its daily100-deployment limit; no further
retry, upgrade, plan change or live-deployment claim.

The final graph source now includes the independently verified Auto default
and actual merged Settings A1 d7582739, with all three changelog entries
preserved. Browser-tested graph/Mechanics/filter source hashes are checked
again after integration; fresh exact-head GitHub checks are required before
merge. Screenshots remain synthetic, and production remains unverified.
