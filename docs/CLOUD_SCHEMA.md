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
  "preferences": {                  // GET/PUT /v1/me/preferences/:type
    "buildCheckin": {               // build check-in switches; absent = all true
      "enabled": true,              // false: no pending check-ins, no agent cards, no randomizer hold
      "askAtLoading": true,         // agent loading-screen card
      "askAfterGame": true          // agent end-of-game card
    },
    "randomizer": { "version": 2, "matchups": { "PvZ": { "enabled": true, "builds": [ { "id": "pvz-2-stargate-phoenix", "...": "..." } ] } } }
  },
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
  "buildIntent": {                  // build check-in, server-owned (never accepted from uploads)
    "status": "confirmed",          // none | pending | confirmed | skipped
    "build": { "key": "pvz-2-stargate-phoenix", "name": "PvZ - 2 Stargate Phoenix", "slug": null, "source": "catalog" },
    "applied": true,                // true only while myBuild/_customBuildSlug carry `build`
    "detected": { "name": "PvZ - Macro Transition (Unclassified)", "slug": null }, // classifier label while applied
    "suggestion": { "key": "...", "name": "...", "slug": null, "source": "catalog",
                    "reason": "randomizer", "passedRules": null, "ruleCount": null }, // declared|randomizer|detected|rules|usual
    "randomizer": null,             // BuildRef the OBS randomizer rolled for this game
    "origin": "pregame",            // pregame | postgame | web | null
    "via": "agent",                 // agent | web | null
    "gameKey": "Opp|Me#123|1717000000000", // live key bound at ingest (first-wins marker)
    "notes": "",                    // private, <= 1000 chars; served only by the build-intent routes
    "confirmedAt": ISODate,
    "updatedAt": ISODate,
    "opponent": {                   // correction of the opponent's build; absent = never corrected
      "status": "confirmed",        // none | confirmed (no pending queue on this axis)
      "build": { "key": "zvp-ling-bane-bust", "name": "ZvP - Ling Bane Bust", "slug": null, "source": "catalog" },
      "applied": true,              // true only while opponent.strategy/_customOpponentStrategySlug carry `build`
      "detected": { "name": "Zerg - 12 Pool", "slug": null }, // classifier's opponent label while applied
      "origin": "web",              // postgame | web | null
      "via": "web",                 // agent | web | null
      "confirmedAt": ISODate,
      "updatedAt": ISODate
    }
  },
  "createdAt": ISODate,
  "_schemaVersion": 8
}
```

`buildIntent` (schema v8): a confirmed, applied check-in rewrites `myBuild`
(and `_customBuildSlug` for a custom build) to the declared build, so every
per-user W-L surface counts the game; `buildIntent.detected` keeps the
classifier's label for cross-user readers and the classifier itself. Keys
are era-neutral (`catalogKeyForName`, or `custom:<slug>`); `build.name` is
spelled for the game's patch ("8 Pool" on 5.0.16). Rows without a
check-in have no `buildIntent`; a notes-only write creates `status: "none"`.
Rolling back to v7 restores the detected label exactly and drops the
subdocument.

`buildIntent.opponent` corrects the opponent's build the same way: while
`applied`, `opponent.strategy` (and `_customOpponentStrategySlug` for one of
the user's opponent-perspective custom builds) carry the corrected build,
spelled for the game's patch, and `detected` keeps the classifier's opponent
label. Opponent keys are `catalogKeyForName` of a counters-catalog strategy
of the user's matchup (`strategyNamesForMatchup`, e.g. "Zerg - 12 Pool" in
PvZ) or `custom:<slug>`. It is written only by `PUT
/v1/games/:gameId/build-intent` (`opponentBuildKey` on any action, or
`action: "opponent"`); `null` clears it, restoring the detected label
exactly and leaving `status: "none"`. Too-short, non-1v1 and resumed games
never take it. The "you"-axis writes merge `buildIntent` shallowly, so they
keep this subdocument; the v7 rollback restores the opponent label too.

Indexes:

| Spec                                              | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `{userId: 1, gameId: 1}` unique                   | Idempotent upsert from agent retries               |
| `{userId: 1, date: -1}`                           | Games tab (newest first), recent-history charts    |
| `{userId: 1, oppPulseId: 1, date: -1}`            | Per-opponent drilldown                             |
| `{userId: 1, "buildIntent.status": 1, date: -1}` partial (`status: "pending"`) | Build check-in pending queue |

Note: the `oppPulseId` field on the index is the legacy alias. The
service writes the pulse id under both `opponent.pulseId` (nested) and
`oppPulseId` (top-level) for index efficiency. New consumers should
read `opponent.pulseId`.

Hot queries:

- `updateOne({userId, gameId}, {...})` upsert — every game ingest.
- `find({userId}).sort({date: -1}).limit(100)` — Games tab.
- `find({userId, oppPulseId}).sort({date: -1})` — opponent drilldown.

---

## `build_intent_live`

One short-lived row per live game key (build check-in). The agent's live
envelope registers it; the loading-screen card, the web and the OBS
randomizer write to it; the replay upload binds it to the game
(`gameId`), after which it is read-only. Purge-only on account deletion
(never exported or restored).

```jsonc
{
  "userId": "...",
  "gameKey": "[oM]Opp#123|Me#456|1717000000000", // sorted /game names + agent ms at loading
  "keyStartedAtMs": 1717000000000,
  "playerNames": ["opp", "me"],     // normalised (clan tag, #discriminator stripped; lowercase)
  "myRace": "Protoss",              // Protoss | Terran | Zerg | Random | null (envelope wins)
  "oppRace": "Zerg",
  "oppName": "[oM]Opp",
  "matchup": "PvZ",                 // null until both races are concrete
  "declared": { "key": "...", "name": "...", "slug": null, "source": "catalog", "at": ISODate, "via": "agent" },
  "postgame": { "buildKey": "...", "skip": false, "notes": "...", "at": ISODate, "via": "agent" },
  "randomizer": { "key": "...", "name": "...", "slug": null, "source": "catalog", "at": ISODate, "verifiedPool": true },
  "hold": { "untilMs": 1717000006000, "released": false, "decidedAt": ISODate }, // OBS randomizer hold (6 s)
  "askClient": true,                // a device-authenticated `register` (the agent's check-in card) came in
  "loadingSeen": true,              // the agent saw this key's own loading screen (a key first seen mid-match is a re-key)
  "gameId": null,                   // set by the ingest bind
  "boundAt": null,
  "createdAt": ISODate,
  "updatedAt": ISODate,
  "expiresAt": ISODate,             // createdAt + 12 h; now + 7 d once declared/postgame/randomizer is set
  "_schemaVersion": 1
}
```

Indexes:

| Spec                                          | Purpose                                   |
| --------------------------------------------- | ----------------------------------------- |
| `{userId: 1, gameKey: 1}` unique              | One record per live game                  |
| `{userId: 1, gameId: 1, keyStartedAtMs: 1}`   | Ingest bind: unbound records by start time |
| `{expiresAt: 1}` TTL (`expireAfterSeconds: 0`) | Reap records                              |

`hold` stays `null` until `askClient` is set and the matchup is concrete:
envelope-only records (a headless agent shows no loading card) never hold
the OBS reveal. The ingest bind takes the newest record that saw its own
loading screen before the replay started as this match's; it and the re-keys
after it (first seen mid-match, or a rejoin's loading screen) are claimed
post-game answer first, then a declaration, then
empty ones. Records keyed before it saw an earlier loading screen (an earlier
match against the same opponent) come after them, newest first; without any
`loadingSeen` record every candidate is ranked answer first. A record keyed
after the replay started (an agent that first saw the match mid-game) binds
only when it carries an answer and names the replay's opponent. A bind that
fails after claiming gives the record back unless the game write landed.

Hot queries:

- `findOneAndUpdate({userId, gameKey, gameId: null}, pipeline, {upsert})` —
  registration and every live write.
- `find({userId, gameId: null, keyStartedAtMs: {$gte, $lt}}).sort({keyStartedAtMs: -1}).limit(5)`
  — ingest bind candidates (window: 10 min before the replay's start to
  min(start + 60 s, end)); a second range query, start + 60 s to the end,
  filtered on `postgame`/`declared` being set, finds records keyed mid-game.

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

A slug stays taken after a soft delete: `PUT /v1/custom-builds/:slug` with
`createOnly: true` (the "Add new build" editor of the build check-in)
answers 409 `slug_taken` when a live or deleted build has the slug, so it
never overwrites or revives one. Builds with `perspective: "opponent"`
(`race` = the opponent's race, `vs_race` = the user's) are the build
check-in's opponent options.

Hot queries:

- `find({userId, deletedAt: {$exists: false}}).sort({updatedAt: -1})` —
  list endpoint.
- `findOne({userId, slug, deletedAt: {$exists: false}})` — detail view.
- `findOne({userId, slug})` — create-only saves (live or deleted).

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
  "shareReplay": false,             // asker's opt-in: signed-in reviewers may download the .SC2Replay
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

## SC2 Tools Guides collections

Public build guides (`/guides`, served by
[`routes/guides.js`](../apps/api/src/routes/guides.js)). Floors and
windows live in [`config/guides.js`](../apps/api/src/config/guides.js):
by default a number is published only for ≥ 30 games from ≥ 5 users, a
page only for ≥ 100 games from ≥ 5 users (each floor can be set per
deployment; see [guides.md](guides.md#floors-and-ranking)). No guide collection is part of the
GDPR export; `guide_samples` rows are deleted with the account or a
history wipe, the user's example replays are pulled from `guide_stats`,
and `guide_notes.updatedBy` is scrubbed to `null`.

### `guide_samples`

Pseudonymous per-game guide inputs captured at ingest
([`services/guideSamples.js`](../apps/api/src/services/guideSamples.js))
or by the admin-started backfill. No userId, gameId or name: the keys
are HMACs with the server pepper.

```jsonc
{
  "userHash": "…", "gameHash": "…",          // hmac("guide-sample-user-v1\0"+userId), hmac(…+userId+"\0"+gameId)
  "buildKey": "PvZ - Stargate into Glaives", "matchup": "PvZ", "era": "after|before",
  "leagueBand": 4 | null, "mmrBand": 4000 | null, "result": "Victory|Defeat|Tie",
  "map": "…", "durationSec": 640 | null,
  "playedOn": ISODate | null,                           // UTC day played (midnight; day precision only)
  "milestones": { "Pylon": 18, "Nexus#2": 95 },          // recorded build-log seconds
  "army": { "360": { "Adept": 4, "Oracle": 1 } },         // checkpoints 360/480/600 when present
  "createdAt": ISODate, "updatedAt": ISODate, "_schemaVersion": 1
}
```

| Spec | Purpose |
| ---- | ------- |
| `{userHash: 1, gameHash: 1}` unique | Idempotent upsert; its prefix serves GDPR deletes and `/guides/me` |
| `{matchup: 1, buildKey: 1, era: 1}` | Nightly per-matchup aggregation |
| `{createdAt: 1}` TTL 400 days | Rows age out |

### `guide_stats`

The nightly aggregate
([`services/guideStats.js`](../apps/api/src/services/guideStats.js)),
rebuilt in full each run; stale docs are swept. Kinds and keys:
`build:<era>:<matchup>:<buildSlug>`, `matchup:<era>:<matchup>`,
`counter:<era>:<matchup>:<strategySlug>`, `map:<era>:<mapSlug>` and one
`run` doc. Every numeric group is a floor-clearing Cell
`{games, users, wins, winRate, ci: {low, high}}`; build docs also carry
bands, timings, army, vs-strategy, lengths, maps, macro, leaks, trend,
`isNew`, `firstPublishedAt` and up to 3 examples (opted-in replay
sharers only: handle, display name, result, map, length, date).
`baseline` / `baselineCandidate` are internal week-over-week snapshots and
are never served.

| Spec | Purpose |
| ---- | ------- |
| `{key: 1}` unique | Replace-by-key writes, page reads |
| `{kind: 1, era: 1, matchup: 1}` | Hub, matchup, sitemap reads |

### `guide_notes`

Coach's notes (admin-edited;
[`services/guideNotes.js`](../apps/api/src/services/guideNotes.js)).

```jsonc
{
  "matchup": "PvZ", "buildKey": "PvZ - Stargate into Glaives",
  "body": "### Game plan …",                                 // markdown, ≤ 4000 chars
  "videos": { "pinned": ["YcTMc_Ee11w"], "hidden": [] },    // per-guide video overrides (≤ 3 / ≤ 20)
  "updatedBy": "<internal admin userId>" | null,             // PRIVATE; GDPR scrubs to null
  "updatedAt": ISODate, "_schemaVersion": 1
}
```

| Spec | Purpose |
| ---- | ------- |
| `{matchup: 1, buildKey: 1}` unique | One note per guide build |

Public pages expose `{body, updatedAt}` only.

### `guide_videos`

The site owner's build-order videos
([`services/guideVideos.js`](../apps/api/src/services/guideVideos.js)):
committed snapshot + channel RSS sync + admin additions.

```jsonc
{
  "youtubeId": "YcTMc_Ee11w", "title": "…", "description": "…",
  "publishedAt": ISODate | null,             // null for an admin-added video the feed has not dated
  "channelId": "UC…", "source": "rss|snapshot|admin",
  "isShort": false, "hidden": false, "updatedAt": ISODate, "_schemaVersion": 1
}
```

| Spec | Purpose |
| ---- | ------- |
| `{youtubeId: 1}` unique | Upsert key |
| `{publishedAt: -1}` | Newest-first reads |

---

## Schema versioning

Every document carries `_schemaVersion` (integer; `1` for most
collections, `8` for `games`).
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
