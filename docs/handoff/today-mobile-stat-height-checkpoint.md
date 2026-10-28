# Today mobile statistic card height

Source prepared 2026-10-27 on `codex/today-mobile-stat-height`, based on main
`900ac8dc55954cd07d0b1162bac3f0d18207106d`. No runtime, tests, build, commit,
deployment or live acceptance is claimed by this preparation.

## Cause and bounded fix

`DashboardKpiStrip` applied `auto-rows-fr` at every viewport. Below the existing
desktop breakpoint, the session spans the first two-column row. Equal fractional
implicit rows then spread its intrinsic height to both following statistic rows,
even when those cards have short, populated content.

The grid now uses content-sized implicit rows below `lg`; the desktop rule and
five-column layout remain. Each mobile pair still aligns within its own row.
`StatCard`, `CurrentSessionCard`, dynamic loading and session height retention,
all API keys, counts, filters, scopes, menus and request handling are unchanged.
The Today Help article describes the compact mobile cards and corrects its
existing session label to match the already-delivered live session behavior.

## Verification required

The focused browser specimen mounts the actual Dashboard strip, session card,
stat cards and Win rate menu, current CSS/tokens and local fonts. Only Next
link/dynamic adapters and the API/session request boundaries use synthetic data.
It covers populated content, complete empty answers and initial loading in both
themes, with 320/390/768/1280 layouts. Geometry must show that each mobile stat
row fits its own tallest content, while the desktop row still aligns all five
cards. Full labels/values, menu Escape/focus, existing links, request scopes and
AA checks remain asserted. There is no live account, provider or write operation.

Root must run the existing KPI scope/live/session-loading unit regressions,
focused browser proof, types/lint, Help index determinism, production build and
all unchanged route budgets. Exact-head CI, merge/deployment and signed-in live
acceptance remain separate delivery gates. Broader roadmap items stay open.

Root verification:19 existing KPI tests and6 single-worker browser cases pass. The browser matrix covers24 populated/empty/loading specimens and24 AA scans at320/390/768/1280px in both themes, with zero page errors, unexpected requests or filter writes. At390px the populated synthetic session is457px while the stat rows are214px and132px; desktop alignment is retained. Root reviewed390light and1280dark captures. The initial test's standalone record locator failed because the record and qualifier share one hint element; the complete record+scope assertion was repaired without changing values or geometry. Original failure evidence remains under .cache/today-mobile-stat-height-verification-20261027/browser-01. Whole types, lint, build, all unchanged budgets, CI and live acceptance remain required.

Final local source a7d199e6 includes the tested dashboard and Arcade changes. Standalone whole-web types including browser specs, strict owned lint, production build, all83 original budgets, deterministic Help97, UI baseline/rule checks and unchanged40source/sevenasset/fourgame admission pass. No source or API coupling issue was introduced by integration. Exact-head CI and signed-in phone acceptance remain pending. Macro's compact-header alternative is preserved separately and is not included after the owner reported current behavior working.
