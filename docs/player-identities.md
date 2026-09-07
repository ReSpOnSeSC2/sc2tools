# Reviewed barcode identities

Barcode opponent profiles have a **Player identity** card next to the behavioral identity candidates. Signed-in users select an existing character and explain their guess. Search accepts a player-name prefix, a Battle.net toon handle, or a numeric SC2Pulse character ID. The **Use SC2Pulse profile** option verifies a character URL/ID directly with SC2Pulse and adds its real public identity to the directory before selection; the character need not have appeared in a replay yet.

Administrators see immediate **Confirm identity** controls on the same card, including correction and removal. Other users submit for review. **Admin → Player identities** contains the pending queue and approved/rejected history. A reviewer sees the exact submitted source, selected target, explanation, and paginated replay evidence; the full admin replay profile remains available for inspection. Approval may select a different target after review. Rejection returns a review note, and the submitter can edit and resubmit.

## Persistence and identity resolution

- `player_identity_directory` is an indexed, public-metadata-only character directory. It streams real opponent/Pulse/channel records in batches on first use and then processes changed records at most once per minute. Its checkpoint survives API restarts. Search returns at most 20 characters per page, with exact IDs and race/region for name disambiguation. It never copies private replay statistics or notes into the directory.
- `player_identity_submissions` stores the user-scoped guess, explanation, review state, and replay snapshot boundary. Evidence is read from that submitter's exact opponent history and excludes replay resumes and later uploads. Deleted games are not resurrected. Account deletion purges submissions; exports include the caller's submissions, and restores cannot restore moderation state.
- `player_identities` stores admin-approved, shared source-to-target links. Names are labels only; exact toon/Pulse IDs are the join keys. Target-side cached Pulse account/pro relationships participate in the existing grouping feature. Unapproved guesses never enter the global resolver.
- Graph changes and reviews use MongoDB transactions with a shared revision fence. Production therefore requires a transaction-capable MongoDB replica set (including Atlas). Stale edits return a conflict rather than overwriting a newer decision. Target links are flattened, self-links/cycles are rejected, and removing a link retains a revision tombstone. A profile with other barcode links pointing to it must have those links updated before it can itself be reassigned.

Approved identities apply across users in opponent lists and profiles. The existing **Group same player** toggle controls aggregation of that user's games. Recorded names, source IDs, per-account notes, and replay records remain intact. Confirmed players inherit their target's approved channel directory links. Replay rows continue to show only actual matched recordings with timestamps.

The played account name stays visible beside an **AKA** badge for the confirmed player. Current ladder ratings and ladder context use the confirmed target's main SC2Pulse profile, with a source label and link. The played account's Pulse/toon identifiers and each replay's game-time MMR remain unchanged. Cached ladder responses for a previous target are hidden while the updated profile loads.

## API

All identity search and submission routes require authentication. Mutation and search rates are bounded; responses are private and uncached.

- `GET /v1/player-identities/search?q=…&cursor=…`
- `POST /v1/player-identities/pulse` with `{ profile }`
- `GET|POST /v1/opponents/:pulseId/identity-submissions`
- Admin-only `PUT|DELETE /v1/opponents/:pulseId/confirmed-identity`
- Admin-only `GET /v1/admin/player-identities?status=pending|approved|rejected|removed&cursor=…`
- Admin-only `GET /v1/admin/player-identities/:id?cursor=…`
- Admin-only `POST /v1/admin/player-identities/:id/review`

This feature changes the cloud API and website only; it does not require a desktop agent version bump.
