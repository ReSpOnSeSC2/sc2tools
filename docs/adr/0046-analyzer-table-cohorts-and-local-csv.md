# Analyzer table cohorts and local CSV

Status: accepted, 2026-10-25.

Build and build-versus-strategy responses carry P/T/Z counts in their existing
aggregation. These counts select the default matrix matchup without inferring a
race from a build name. A global opponent-race filter wins; otherwise one selected
matchup reuses the existing endpoint. There is no per-race request fanout.

The local matchup follows a clicked matrix cell into its games and both phase
comparison columns. Later global matchup edits take priority. Strategy drills
remain mounted in a shared Modal above the existing list and support controlled
state for the subsequent URL-navigation pack. Filter edits refetch in place.

Heatmap axes use visible game volume or a saved alphabetical order. Background
alpha carries sample size, while opaque black/white labels are chosen against
the actual theme surface at WCAG 4.5:1. Tests independently measure emitted CSS.

CSV exports serialize the visible filtered/sorted table models locally, with
shared header configurations, a BOM, CRLF, guarded text cells, numeric measures,
scope and local date. Map exports explicitly distinguish displayed overall rows
(which retain all games) from matchup cells passing Min games. Pool exports
include each displayed P/T/Z/All cell and record the independent planner scope.
No database export job, provider call, infrastructure or bundle-budget change.
