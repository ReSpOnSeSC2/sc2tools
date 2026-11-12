# 0085. Reuse local replay headers for the career record

Date: 2026-11-12

## Context

A replay record should cover the files the player selects, across modification dates and replay years. Selecting an updated folder should reuse work without uploading replay data or requiring a browser to retain a folder handle.

## Decision

- Use the local single-worker header path from ADR 0079 with no file-modification prefilter. Show human one-versus-one ladder games whose header identifies the match and its date. Dates, weekday habits and yearly summaries use UTC. A 90-day gap is a gap in this selection.
- Key cached headers by SHA-256 of the complete selected file. Save validated headers without path-derived account hints and resolve hints from the current selection. Include the header schema and engine protocol/version in the cache format.
- Keep one snapshot in a separate IndexedDB database. A completed scan replaces that snapshot in a transaction. A clear transaction changes its generation so an earlier scan in another tab cannot write the cleared snapshot back. Continue scanning in memory when storage is unavailable.
- Serve the page with the same local replay shell and telemetry exclusions as the year recap. Keep the existing Instant Analysis availability rule.

## Consequences

A rescan reads files to check their fingerprints and parses only the uncached files. Browser storage holds header data locally until it is cleared, replaced or evicted. A replay without readable ladder metadata may be left out. Old-era replay parity needs representative fixtures before a historical coverage claim.
