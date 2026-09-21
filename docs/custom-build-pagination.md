# Custom build library pagination

Saved custom builds have no count quota. Resource limits apply to each request
and matching batch, rather than to the number of builds an account can save.
The existing validation limits on individual build fields and rules remain.

## Library API

`GET /v1/custom-builds` returns:

```json
{
  "items": [],
  "total": 137,
  "libraryTotal": 160,
  "limit": 50,
  "nextCursor": "opaque-token-or-null",
  "truncated": false
}
```

- `total` counts builds matching the current search and filters.
- `libraryTotal` counts every non-deleted saved build in the account.
- `limit` is the page size: 50 by default, with a request maximum of 100.
- Pass `nextCursor` back as `cursor` with the same filters, sort, view and limit.
  A null cursor means the end of the results. Cursors are bound to the account
  and query; malformed or mismatched cursors return HTTP 400.
- `truncated` remains false for compatibility. It does not describe paging or
  impose a library quota. Clients must follow `nextCursor`.

Supported filters are `search`, `matchup` (for example `PvT`), `hideEmpty=true`,
and `sort=updated|name|games|winRate`. Search, filtering, counting and sorting
happen before pagination. Sorting uses the unique slug as its final tie breaker.
Game and win-rate ordering use the same perspective-specific provenance as the
library statistics and exclude resumed replays.

`includeGeneric=true` includes builds with no specific opponent race alongside
an explicit matchup. The randomizer uses this option. The library uses exact
matchups by default.

`name` matches an exact display name or slug for existing replay-label lookups.
`normalizedName` additionally ignores an initial matchup prefix, case and
repeated whitespace for the analyzer's existing comparison lookup.

`view=summary` returns only bounded catalog metadata such as slug, name, races,
perspective and update time. It omits rules, signatures and notes. Pickers use
this view. Arcade reads successive slim catalog pages because its games need
the full set of names.

The analyzer's Builds tab uses `/v1/builds` replay analytics for both detected
and custom builds. A saved definition appears there only after matching games
are classified with its label and satisfy the selected replay filters, search,
and minimum-game threshold. Definitions without matching games stay in the
`/builds` library. Opponent-side definitions contribute to Strategies.

`GET /v1/custom-builds/stats?slugs=slug-a,slug-b` returns statistics only for the
requested visible builds, with at most 100 slugs per request. Without `slugs`,
the endpoint returns the first recency page for older clients. Stats never
match builds by display name.

Edits can change the order or membership of a live result set. Clients reset
paging after mutations, filter changes or an account switch. A failed or empty
later page retains navigation back to earlier pages.

## Replay matching

Replay history is read in batches of 50 games. Each game batch is scored
against successive batches of 50 build definitions, using the indexed unique
account/slug order. Only the strongest passing and uncertain candidate for
each game and perspective is retained between build batches.

Winner priority is independent of page order: more rules, then the most recent
edit, then slug order. A later build can therefore supersede an earlier match.
An unavailable higher-priority candidate still defers classification on its
perspective. The player's build and opponent strategy are scored independently.

An incremental fingerprint verifies that every replay batch used the same
projected build definitions. A concurrent edit, including a save without
reclassification, aborts a pass that observed different definitions; staged
decisions are removed and the durable worker can retry. Existing worker leases,
replay revision checks and final publication fences remain in force.

Memory in the API process is bounded by the current game batch, build batch,
and compact candidate state. Large legacy fields are projected and bounded in
Mongo before reaching the process. Library sorting can spill to database disk.

Internal reclassification diagnostics retain at most 100 `perBuild` summary
rows in slug order and explicitly set `perBuildTruncated` when there are more.
This only limits diagnostic detail: matching and total progress counts cover
every build.
