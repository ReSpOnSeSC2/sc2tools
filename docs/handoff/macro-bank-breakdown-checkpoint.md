# Macro Bank breakdown

2026-10-26. Source-only work on `codex/fix-macro-bank-breakdown`, based on
`dce88719d3fe9faeaab82786dfd0a95279bb4b20`. No checks or runtime execution yet.

Bank remains one metric in the existing multi-select/All controls. When Bank is
selected, Total, Minerals and Gas choose which two player lines are plotted.
New device preferences default to Total; the validated resource choice is saved
separately from the existing metric mix. Both modal and full-game Macro share
this chart path.

The selected-time panel and hover card show Total, Minerals and Gas for each
player, all from the same prior stats sample as the roster. Valid individual
components remain visible when the other is absent; Total requires both.
Zero is a measured value. Missing, negative or nonfinite components remain
unknown. No API, engine or native payload change is required.

View changes do not alter inspection/seek callbacks. Existing graph taps and
scrubs still use the previously shipped in-place clock/roster behavior.
Explicit replay links keep their existing behavior.

The 13-path scope consists of eight shared macro product files, two existing
focused test files, the existing game-page Help article, changelog and this
checkpoint. Raw before copies are preserved in
`.cache/macro-bank-before-dce88719/`, receipt SHA
`c38f963ec41cdf3b371575ec87fc8ba75d8a6c76396383fbf577f0a9cbc64bb5`.
No new article path was added, so Help index generation is unnecessary.

Authored checks cover individual/total values, missing/invalid/zero samples,
prior-sample alignment, resource-specific layout scales, validated preference
recovery, independent saved choices, view-switch selection stability and
unchanged graph-seek behavior. They are **UNRUN**. Whole-web types, focused lint,
appropriate neighboring tests, Help checks, production build/budgets and a
current-CSS browser check remain pending the parent's serialized runtime grant.
