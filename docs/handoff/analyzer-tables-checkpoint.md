# Analyzer tables — analyzer-home-polish-4

Owned branch: `codex/wave3-analyzer-tables` in `.worktrees/admin-build-studio`.
The original Build Studio and Dossier B branches are preserved.

Implemented: keyboard build-name buttons and global matchup chips, W/L split,
labelled search, shared radio segmented controls, persistent matrix axis order,
measured matchup defaults, readable sample-alpha cells, an in-place Strategy
games sheet with controlled state and active filter labels, design-system KPI
cards, persistent View games hints, and visible-row CSV for Builds, matrix,
Matchups, detailed Maps and all pool cells. Opponents keeps its complete-cohort
and owner guards while adopting the same local-date filename helper.

Existing API aggregation groups now return race counts without another read.
Seventy-one Mongo/API tests in builds/aggregations/new matchup metadata passed;
API types passed and affected legacy services retain six existing lint warnings,
with no errors. Full web types and strict changed-source lint are being rerun;
focused CSV, contrast, Builds, Strategy and Maps tests pass as recorded in logs.
The integrated main725 build passed every unchanged budget (Today238.7/240,
Dock224.3/225, landing214.6/215), including the reviewed shared Build editor
Modal. Browser104 checks pass at320/390/768/1440 in both themes, including
native Tab/Enter, Escape/focus return, held filter refetch, zero export and
actual downloaded CSV content. Thirty-two captures were generated and
representative phone/desktop heatmap, sheet and map views reviewed.
Independent review corrected stale games/phase data and made both comparison
columns share the clicked axes. Sixty final affected consumer tests pass.
The full web run and remote gates are still pending.

ADR 0046 explains cohort and export boundaries. The following URL-drill pack
`analyzer-home-polish-5` is still outstanding. No production actions, new
infrastructure, budget changes, release or version changes were performed.
