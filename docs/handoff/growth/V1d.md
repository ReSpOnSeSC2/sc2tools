# V1d · Floating cards and scouting report

- **Shipped.** Loading and post-game check-ins, embedded Build selectors and the floating scouting report use the active Agent skin. The scouting report has a slimmer frame and distinct selected rows and timing labels.
- **Layout.** Compact and expanded check-ins remain usable at 125% and 150% scaling. The report keeps opponent-first stacking at and below 500 pixels.
- **Review.** Added a regression test for repainting an embedded selected row when the skin changes. Captured the locked loading card and both embedded tabs.
- **Tests.** 538 focused Agent tests across 29 files and `git diff --check` passed.
- **Mutations.** Eight of eight killed in `C:/SC2TOOLS/.cache/growth-V1d-tools/mutation-01/`.
- **Pictures.** Six inspected `v1d-*.png` contact sheets under `C:/SC2TOOLS/.cache/growth-V1d-tools/` cover all four skins, compact and expanded cards, embedded tabs at both window sizes, private notes and scrolled build orders.
- **Not verified.** Installed Agent and in-game translucency and click-through.
- **Follow-up.** Include the floating surfaces in the V1e gallery.
