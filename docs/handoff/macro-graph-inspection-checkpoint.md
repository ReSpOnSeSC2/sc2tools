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
