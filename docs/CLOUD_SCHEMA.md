# Cloud database schema — `sc2tools_saas`

Source of truth for collection shapes, indexes, and the hot queries
each index exists to serve. Derived from
[`apps/api/src/db/connect.js`](../apps/api/src/db/connect.js) and the
service modules under [`apps/api/src/services/`](../apps/api/src/services/).

If you change a collection's shape, also bump its entry in
[`apps/api/src/db/schemaVersioning.js`](../apps/api/src/db/schemaVersioning.js)
and update this file in the same PR.

---

## Database

- Name: `sc2tools_saas` (overridable via `MONGODB_DB`)
- Region: pick the same region as Render — Oregon for the default
  `apps/api/render.yaml`
- Collation: server default (binary), case-sensitive

All documents include a `_schemaVersion: number` field stamped by
the API on write (see schema-versioning section at the bottom).

---

## `users`

One document per signed-in Clerk identity. The internal `_id` is the
join key for every other collection's `userId`.

```jsonc
{
  "_id": ObjectId,                  // internal id (string-cast as userId elsewhere)
  "clerkUserId": "user_abc...",     // Clerk's stable id
  "email": "you@example.com",
  "createdAt": ISODate,
  "lastSeenAt": ISODate,
  "_schemaVersion": 1
}
```

Indexes:

| Spec                       | Purpose                          |
| -------------------------- | -------------------------------- |
| `{clerkUserId: 1}` unique  | JWT → user lookup on every request |

Hot queries:

- `findOne({clerkUserId})` — middleware `auth.js` resolves on every API call.

---

## `profiles`

Optional per-user profile (battle-tag, target MMR, races they play).
One per user. Created lazily on first `/v1/me` write.

```jsonc
{
  "userId": "...",
  "battleTag": "ReSpOnSe#1872",
  "characterId": "1-S2-1-267727",
  "accountId": "50983875",
  "region": "us",
  "races": ["Protoss"],
  "mmrTarget": 6000,
  "preferredName": "ReSpOnSe",
  "updatedAt": ISODate,
  "_schemaVersion": 1
}
```

Indexes: none beyond the implicit `_id`. Always queried by `userId`
which is small enough to scan; if profile traffic ever spikes, add
`{userId: 1}` unique.

---

## `opponents`

One document per `(userId, pulseId)`. Aggregates win/loss + opening
counts per opponent so the opponents list page renders without joins.

```jsonc
{
  "userId": "...",
  "pulseId": "452727",
  "displayNameHash": "<hex>",       // HMAC of last seen battle tag
  "displayNameSample": "Hiza",      // last plaintext, owner-only
  "race": "T",                      // last seen race
  "mmr": 4123,
  "leagueId": 5,
  "gameCount": 17,
  "wins": 9,
  "losses": 8,
  "firstSeen": ISODate,
  "lastSeen": ISODate,
  "openings": { "Pool_first": 3, "Hatch_first": 2 },
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `{userId: 1, pulseId: 1}` unique        | Idempotent upsert on every game ingest         |
| `{userId: 1, lastSeen: -1}`             | `/v1/opponents` recent-activity feed           |

Hot queries:

- `updateOne({userId, pulseId}, {...})` upsert — runs once per game accepted.
- `find({userId}).sort({lastSeen: -1}).limit(N)` — the Opponents tab.

---

## `games`

One document per `(userId, gameId)`. `gameId` is whatever the agent
supplies — typically `"<ISO date>|<opponent>|<map>|<duration>"` so it's
deterministic and re-uploads dedupe.

```jsonc
{
  "userId": "...",
  "gameId": "2026-01-11T16:48:51|SpeCial|10000 Feet LE|384",
  "date": ISODate,
  "result": "Victory",              // Victory | Defeat | Tie
  "myRace": "Protoss",
  "myBuild": "PvP - 4 Stalker Oracle into DT",
  "map": "10000 Feet LE",
  "durationSec": 384,
  "macroScore": 77,
  "apm": 142,
  "spq": 108.55,
  "opponent": {
    "pulseId": "...",
    "displayName": "SpeCial",
    "race": "Protoss",
    "mmr": 4500,
    "leagueId": 5,
    "opening": "Standard Expand",
    "strategy": "Protoss - Standard Expand"
  },
  "buildLog": [ "[0:00] Probe", "..." ],
  "earlyBuildLog": [ "..." ],
  "oppEarlyBuildLog": [ "..." ],
  "oppBuildLog": [ "..." ],
  "createdAt": ISODate,
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                              | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `{userId: 1, gameId: 1}` unique                   | Idempotent upsert from agent retries               |
| `{userId: 1, date: -1}`                           | Games tab (newest first), recent-history charts    |
| `{userId: 1, oppPulseId: 1, date: -1}`            | Per-opponent drilldown                             |

Note: the `oppPulseId` field on the index is the legacy alias. The
service writes the pulse id under both `opponent.pulseId` (nested) and
`oppPulseId` (top-level) for index efficiency. New consumers should
read `opponent.pulseId`.

Hot queries:

- `updateOne({userId, gameId}, {...})` upsert — every game ingest.
- `find({userId}).sort({date: -1}).limit(100)` — Games tab.
- `find({userId, oppPulseId}).sort({date: -1})` — opponent drilldown.

---

## `custom_builds`

User's private build library. Per-user `slug` is stable across
edits so the agent's local cache reconciles.

```jsonc
{
  "userId": "...",
  "slug": "pvz-dt-into-3-stargate-void-ray-2",
  "name": "PvZ - DT into 3 Stargate Void Ray",
  "race": "Protoss",
  "vs_race": "Zerg",
  "skill_level": "grandmaster",
  "description": "...",
  "win_conditions": [ "..." ],
  "loses_to": [ "..." ],
  "transitions_into": [ "..." ],
  "rules": [ { "type": "before", "name": "...", "time_lt": 244 } ],
  "source_replay_id": "...",
  "createdAt": ISODate,
  "updatedAt": ISODate,
  "deletedAt": ISODate,             // soft delete; absent when active
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                | Purpose                                  |
| ----------------------------------- | ---------------------------------------- |
| `{userId: 1, slug: 1}` unique       | Upsert by slug                           |
| `{userId: 1, updatedAt: -1}`        | List view sorted by recency              |

Hot queries:

- `find({userId, deletedAt: {$exists: false}}).sort({updatedAt: -1})` —
  list endpoint.
- `findOne({userId, slug, deletedAt: {$exists: false}})` — detail view.

---

## `device_pairings`

Short-lived 6-digit pairing codes. The agent generates one and prints
it to the user; the website POSTs it to mint a long-lived device token.
TTL-indexed so expired codes vanish without a cleanup job.

```jsonc
{
  "code": "482917",
  "agentNonce": "<base64url>",
  "expiresAt": ISODate,             // now + 10 min
  "createdAt": ISODate,
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                        | Purpose                                   |
| ------------------------------------------- | ----------------------------------------- |
| `{code: 1}` unique                          | Lookup by code at pairing time            |
| `{expiresAt: 1}` TTL `expireAfterSeconds:0` | Auto-deletes codes once `expiresAt` passes |

Hot queries:

- `findOne({code})` then delete — single use.

---

## `device_tokens`

Long-lived agent credentials. The plaintext token is given to the
agent at pairing time and never stored — only its SHA-256 hash.

```jsonc
{
  "userId": "...",
  "tokenHash": "<sha256 hex>",
  "label": "Gaming PC",
  "createdAt": ISODate,
  "lastSeenAt": ISODate,
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                  | Purpose                              |
| ------------------------------------- | ------------------------------------ |
| `{tokenHash: 1}` unique               | Auth middleware lookup on every POST |
| `{userId: 1, lastSeenAt: -1}`         | `/devices` page list                 |

Hot queries:

- `findOne({tokenHash})` — once per agent request.
- `find({userId}).sort({lastSeenAt: -1})` — devices page.

---

## `overlay_tokens`

Short, high-entropy tokens for the OBS browser source. Anyone holding
one can read the live overlay-event socket room for the linked user.

```jsonc
{
  "userId": "...",
  "token": "<base64url>",
  "label": "Twitch overlay",
  "createdAt": ISODate,
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                 | Purpose                                  |
| ------------------------------------ | ---------------------------------------- |
| `{token: 1}` unique                  | Resolve `/overlay/<token>` page          |
| `{userId: 1, createdAt: -1}`         | List tokens on the streaming page        |

Hot queries:

- `findOne({token})` — overlay page mount.
- `find({userId}).sort({createdAt: -1})` — streaming page.

---

## Replay Review Exchange collections

See [`docs/reviews.md`](reviews.md) for the rules and privacy model.
Public payloads are rebuilt from allow-lists in
[`services/reviewRedaction.js`](../apps/api/src/services/reviewRedaction.js);
`userId`, `gameId` and every opponent identifier below are server-only.

### `review_requests`

```jsonc
{
  "_id": "a1B2c3D4e5F6g7H8",      // random 16-char public id (/reviews/<id>)
  "userId": "...", "gameId": "...", // PRIVATE: the scoped grant's target
  "activeKey": "userId\u0000gameId", // present only while open/answered
  "question": "...", "tags": ["build_order"], "timeRange": {"startSec": 300, "endSec": 420} | null,
  "desiredLevel": "anyone|my_league_or_higher|masters_plus",
  "visibility": "public|link", "askerDisplay": "anonymous|named", "askerName": "..." | null,
  // redacted snapshot frozen at posting time
  "matchup": "PvZ", "myRace": "Protoss", "oppRace": "Zerg", "map": "...", "result": "Win|Loss|Draw",
  "durationSec": 640, "askerBand": {"id": 4, "label": "Diamond"}, "askerMmr": 4100,
  "opponentBand": {...}, "opponentMmr": 4100, "opponentLabel": "Opponent (Zerg, ~4,100 MMR)",
  "myBuild": "...", "oppStrategy": "...", "macroScore": 61,
  "hasPlayback": true, "playbackMode": "segmented|inline|none",
  "status": "open|answered|closed|removed", "closedReason": "asker|game_unavailable|moderator",
  "hidden": false, "reportCount": 0,
  "reviewCount": 0, "commentCount": 0, "helpfulCount": 0, "upvoteTotal": 0, "bestCommentId": null,
  "listed": true, "indexable": false, "hotScore": 12.3, "topScore": 2,  // derived on every write
  "lastActivityAt": ISODate, "createdAt": ISODate, "updatedAt": ISODate, "_schemaVersion": 1
}
```

| Spec | Purpose |
| ---- | ------- |
| `{activeKey: 1}` unique sparse | One live request per game |
| `{userId: 1, createdAt: -1}` | Open/daily caps, `/me/reviews` |
| `{userId: 1, gameId: 1}` | Close requests when games are deleted |
| `{listed: 1, createdAt: -1, _id: -1}` | Board: New |
| `{listed: 1, hotScore: -1, _id: -1}` | Board: Hot (age decay baked into the score) |
| `{listed: 1, topScore: -1, _id: -1}` | Board: Top |
| `{listed: 1, matchup: 1, createdAt: -1}` | Matchup filter, help-with list, digest |
| `{listed: 1, reviewCount: 1, createdAt: -1}` | Unanswered filter |
| `{indexable: 1, lastActivityAt: -1}` | Sitemap |

### `review_comments`

```jsonc
{
  "_id": "...", "requestId": "...", "authorId": "..." | null, "authorDeleted": true?,
  "parentId": null | "...", "isAskerComment": false,
  "gameTimeSec": 312, "endTimeSec": 340 | null, "mapPoint": {"x": 40.5, "y": 61.3} | null,
  "body": "...", "upvotes": 0, "upvoteKarma": 0, "helpful": false, "best": false,
  "reportCount": 0, "status": "visible|hidden|removed|deleted",
  "createdAt": ISODate, "editedAt": ISODate | null, "_schemaVersion": 1
}
```

| Spec | Purpose |
| ---- | ------- |
| `{requestId: 1, createdAt: 1, _id: 1}` | Thread listing |
| `{authorId: 1, createdAt: -1}` | Rate limits, reviewer history, GDPR |
| `{parentId: 1}` sparse | Replies / soft-delete check |

### `review_karma_events`

`{commentId, requestId, kind: "helpful|best|upvote|removed", actorId, userId, points, createdAt}`.
Unique partial `{commentId, kind, actorId}` (`actorId` string only — GDPR nulls
it) makes every reward idempotent; `{userId, createdAt}` and `{createdAt, userId}`
serve recompute and the weekly leaderboard. Totals are materialised on
`users.reviewer` (`karma, helpful, best, upvotes, reviews, removed,
verified, leaderboardOptIn, digestOptOut, digestWeek`; index
`{"reviewer.karma": -1}` sparse).

### `review_blocks`

`{_id, blockerId, blockedId, origin: "named"|"anonymous_request", createdAt}` —
`anonymous_request` blocks (made as an anonymous asker) only filter the
blocker's view and are never enforced as refusals. Unique `{blockerId, blockedId}`,
plus `{blockedId}`.

### `notifications`

`{_id, userId, kind, title, body, href, count, readAt, createdAt, groupKey?}`.
`{userId, createdAt}` lists the bell; `{userId, readAt}` counts unread; the
unique partial `{userId, groupKey}` (unread rows only) folds grouped events
into one row; a 90-day TTL on `createdAt` keeps it a bell, not an archive.

---

## Schema versioning

Every document carries `_schemaVersion` (integer, currently `1`).
The API stamps the current version on every write via
[`apps/api/src/db/schemaVersioning.js`](../apps/api/src/db/schemaVersioning.js).

When you change a document shape:

1. Bump the collection's `currentVersion` in `schemaVersioning.js`.
2. Register a forward + backward migration so on-read documents can
   roll forward, and rollbacks have an escape hatch.
3. Update the shape and indexes in this file.
4. Add a test under
   [`apps/api/__tests__/db/schemaVersioning.test.js`](../apps/api/__tests__/db/schemaVersioning.test.js).

The cloud versioning module mirrors the local-app pattern in
[`reveal-sc2-opponent-main/stream-overlay-backend/lib/schema_versioning.js`](../reveal-sc2-opponent-main/stream-overlay-backend/lib/schema_versioning.js)
so familiar tooling works on both sides.

---

## Cross-references

- [`apps/api/src/db/connect.js`](../apps/api/src/db/connect.js) — index spec
- [`apps/api/src/services/`](../apps/api/src/services/) — write paths
- [`apps/api/src/validation/`](../apps/api/src/validation/) — input shape
  validation (Ajv) before write
- [`docs/cloud/SETUP_CLOUD.md`](cloud/SETUP_CLOUD.md) — Atlas + index
  bootstrap on a fresh cluster
- [`tools/migrate-to-cloud/`](../tools/migrate-to-cloud/) — bulk import
  from the local app's JSON files
