# SC2 Tools Guides

Public, search-indexable StarCraft II build-order pages at `/guides`. Every
number on a guide page comes from real 1v1 ladder games synced by SC2 Tools
users, and nothing is shown below a data floor. ReSpOnSe's build-order
videos from https://www.youtube.com/@ReSpOnSeSC2 are embedded next to the
data.

The pages replace the old public `/meta` page, which now redirects to
`/guides`. The signed-in Ladder Pulse still uses `GET /v1/meta/ladder`.

## Where the data comes from

```
POST /v1/games ──► guide_samples  (one pseudonymous row per eligible game:
      │                            milestone times + army at 6/8/10 min)
      └────────► games (slim row)
                         │
   nightly guideStats job│ one aggregation per matchup, pushed into Mongo
                         ▼
                   guide_stats ──► GET /v1/guides/* ──► /guides pages (ISR)
                         │                                  ▲
                         └── signed POST /api/revalidate-guides ┘
```

- **guide_samples** are written at ingest time, while the game's heavy
  fields (`buildLog`, `macroBreakdown`) are already in memory. This is the
  only cheap way to get corpus-wide timings: the nightly job never reads
  `game_details` or R2.
- **guide_stats** holds one document per era × matchup × build, a hub per
  matchup, a document per map, a "counter" document per matchup × opponent
  strategy, and a `run` document. Every document stores `computedAt` and the
  sample size behind every number.
- **guide_videos** is a library of the channel's videos, refreshed from its
  RSS feed.
- **guide_notes** holds admin-written Coach's notes and per-guide video
  pins and hides.

## Which games count

A game feeds guides only if all of these hold:

- It is 1v1: `playerCount` is 2 or absent, and `matchFormat` is `1v1` or
  absent.
- It is a ladder game: `isLadderGame: true`, or the field is absent and
  `opponent.leagueId` is present. The agent only sends a league for ladder
  games.
- Both races are Protoss, Terran or Zerg.
- It was not resumed from a replay.
- `myBuild` is a catalog opener for that matchup
  (`apps/api/src/config/guideCatalog.json`). This allowlist excludes
  "Game Too Short", unclassified labels, composition fallbacks and users'
  private custom-build names.
- Rows re-tagged by a server-side custom build (`_customBuildSlug`) are
  excluded.

These are the same exclusions as the Ladder Meta Radar, with a catalog
allowlist added so private custom-build names can never appear.

## Eras (patches)

Stats are split into the **current patch** (`after`, 5.0.16 and later) and
**before**. The era comes from the replay's `gameBuild`, else the last
segment of `gameVersion`, else the game date against the 5.0.16 release. The
rules live in `apps/api/src/util/patchEra.js`, shared with the Ladder Meta
Radar.

Pages publish on the current patch. `?era=before` on a matchup page shows
the previous patch.

## Bands

Bands always describe the **opponent**, as on the old meta page:

- **League:** `opponent.leagueId`, from Bronze (0) to Grandmaster (6).
- **MMR:** 500-point half-open ranges of `opponent.mmr`, with the tails
  collapsed to `<2000` and `6500+` (see `util/mmrBracketing.js`).

The matchup page takes `?band=league:4` or `?band=mmr:4500`. Unknown values
are ignored, and the canonical URL never carries a band.

## Floors and ranking

| Constant (`apps/api/src/config/guides.js`) | Value | Meaning |
|---|---|---|
| `GUIDE_CELL_MIN_USERS` / `GUIDE_CELL_MIN_GAMES` | 5 / 30 | Any displayed number (a "cell") needs at least 5 distinct users AND 30 games. |
| `GUIDE_PAGE_MIN_USERS` / `GUIDE_PAGE_MIN_GAMES` | 5 / 100 | A whole page publishes only with at least 5 users AND 100 games in the current patch. |
| `GUIDE_USER_CELL_CAP` | 50 | At most 50 games per user per build per era count (most recent first), so one account can't move a cell. |
| `GUIDE_MILESTONE_MIN_PRESENCE` | 0.6 | A timing row appears only if the milestone occurs in at least 60% of samples. |

- Below the page floor, the API returns the page with `published: false`
  and **no numbers at all**. The web renders a noindex "Not enough games
  yet" page, which still shows the build's description and any videos.
- Distinct users are counted inside MongoDB (`$addToSet` then `$size`), so
  user ids never reach Node.
- Win rates are computed over decided games, with a 95% Wilson interval.
- Every list is ranked by the Wilson **lower bound**, never by raw win
  rate.

## Timings and army

- **Milestone times are the times recorded in the build log.** Buildings
  are logged when they start. Upgrades and morphs (Warpgate, Blink, Lair,
  Orbital) are logged when they finish, and the page says "done" for those.
  We never subtract a research time; that would invent precision.
- **The milestone catalog** is `apps/api/src/config/guideMilestones.js`.
  Keys are stable storage identifiers, so add new ones rather than renaming.
- **Army** comes from `macroBreakdown.unit_timeline` at 6, 8 and 10
  minutes.
  - It uses the nearest sample within 15 s. If there isn't one, the
    checkpoint is omitted, never counted as zero.
  - It keeps the top 8 unit types, excluding workers and Overlords.
  - Pages show the median count when the unit is present, and the share of
    games where it is present.

## Week-over-week movement

Each build document keeps two snapshots:

- `baseline`: a snapshot at least 7 days old, which the trend compares
  against.
- `baselineCandidate`: the next snapshot, which becomes the baseline once
  it is 7 days old.

The trend therefore always compares against a snapshot that is 7–14 days
old. It stays empty until a build has one, and a baseline older than 21 days
is dropped. Rerunning the job on the same day changes nothing.

## Privacy

- **guide_samples** store `userHash` and `gameHash`, which are HMACs made
  with the server pepper (`util/guideHash.js`). They never store user ids,
  game ids, player names, toon handles or pulse ids. Rows expire after 400
  days.
- **Deleting an account** (`DELETE /v1/me`) deletes that user's samples, by
  computing their hash at deletion time. Wiping game history and restoring
  a snapshot do the same.
- **guide_stats** and every public payload are aggregates only.
  `apps/api/__tests__/guidesNoPii.test.js` seeds known names and ids and
  asserts none of them appear in any public response.
- **Example replays** come only from users who enabled public replay
  sharing. Sharing is re-checked when the page is served. They link to that
  user's public replay list, never to a game id (game ids embed the
  opponent's name).

## Slugs

- **Build pages** live at `/guides/<matchup>/<build>`, for example
  `/guides/pvz/stargate-into-glaives`.
- **Counter pages** live at `/guides/<matchup>/counter/<strategy>`, for
  example `/guides/pvz/counter/8-pool` ("How to beat 8 Pool as Protoss").
- **Slug rule:** take the text after the catalog name's `" - "` prefix,
  lowercase it, and turn every run of non-alphanumerics into `-`.
- **Collisions within a matchup:** the matchup-specific name keeps the plain
  slug, and the race-generic one gets its race as a prefix
  (`zerg-2-base-nydus`).
- **`apps/api/src/config/guideSlugs.lock.json` pins the whole mapping.**
  Tests in both apps fail if it drifts, so a catalog rename can't silently
  break URLs. To retire a slug, add an entry to `SLUG_ALIASES` in
  `guideSlugs.js`. The API then answers 301 and the page issues a permanent
  redirect.
- **After editing `apps/web/lib/build-definitions`:**

  ```bash
  cd apps/web && npm run guides:catalog   # re-exports apps/api/src/config/guideCatalog.json
  # then regenerate the lock (command in the header of apps/api/src/config/guideSlugs.js)
  ```

## YouTube videos

- **Library:** `guide_videos` is seeded from a 32-video snapshot
  (`apps/api/src/config/guideVideosSnapshot.json`). Every 6 hours it is
  refreshed from `https://www.youtube.com/feeds/videos.xml?channel_id=…`.
  The feed only lists the newest 15, so older videos are never deleted.
- **Automatic matching** (`services/guideVideoMatch.js`) is conservative and
  deterministic:
  - The title (or a `#PvZ`-style hashtag) must name the matchup.
  - The title must contain the catalog build or opponent strategy as a
    whole phrase of at least two words.
  - Shorts and stream recordings never match.
- **Curated links:** two videos whose titles don't name the build are
  linked from their descriptions.
- **Admin page:** you can pin or hide videos per guide, hide a video
  everywhere, add a video by URL (it must be on the configured channel),
  or sync now.
- **On the page:** the embed is a click-to-play facade using
  `youtube-nocookie.com`. Nothing loads from YouTube until someone clicks.
  Under the video the page shows the description's first paragraph and its
  build checklist verbatim, captioned "From the video by ReSpOnSe".

## Coach's notes

Admins write markdown notes per build (up to 4000 characters) under
`/admin/guides`. They render with a safe subset (no raw HTML; http(s) links
only, with `rel="nofollow"`). Public payloads include only `{ body,
updatedAt }`; who edited a note is never exposed.

## Configuration

API (`apps/api`, see `render.yaml` and `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `GUIDES_ENABLED` | off | Master switch for the `/v1/guides` routes and the nightly stats and video jobs. `on`, `true`, `1`, `yes` or `all` turn it on (the same spellings as the web flag). |
| `GUIDES_REVALIDATE_URL` | unset | `https://<web>/api/revalidate-guides`, pinged after each successful stats run. |
| `GUIDES_REVALIDATE_SECRET` | unset | Shared HMAC secret. Must match the web's value. |
| `GUIDES_YOUTUBE_CHANNEL_ID` / `GUIDES_YOUTUBE_CHANNEL_URL` | ReSpOnSe's channel | Video sync source and the "Subscribe" link. |
| `SC2TOOLS_GUIDE_SAMPLES_DISABLED=1` | — | Stops ingest-time sample capture. Capture is ON by default, so data accumulates before launch. |
| `SC2TOOLS_GUIDE_BACKFILL_DISABLED=1` | — | Blocks the admin-triggered backfill. |
| `SC2TOOLS_GUIDE_STATS_DISABLED=1`, `…_INTERVAL_SEC`, `…_START_DELAY_SEC` | —, 86400, 900 | Nightly stats job. |
| `SC2TOOLS_GUIDE_VIDEOS_DISABLED=1`, `…_INTERVAL_SEC` | —, 21600 | Channel RSS sync. |

Web (`apps/web`, see `.env.example`):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_GUIDES_ENABLED` | `on`, `true`, `1`, `yes` or `all` shows `/guides`, the nav, footer and landing links, and adds guide URLs to the sitemap. Inlined at build time. |
| `GUIDES_REVALIDATE_SECRET` | Verifies the API's revalidation ping. |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | Google Search Console token, added to the root metadata. |

## Rollout

1. **Deploy with both flags off.** Sample capture starts immediately, so
   data accumulates while nothing is public.
2. **Optionally seed history** with the backfill (below).
3. **Set `GUIDES_ENABLED=true`** on the API. The stats job runs 15 minutes
   after boot and then nightly. Check `/admin/guides` for the run summary
   and the published counts.
4. **Set the revalidation URL and secret** on both apps, and
   `NEXT_PUBLIC_GUIDES_ENABLED=on` on the web, then redeploy the web. `/meta`
   now 308-redirects to `/guides`.
5. **Submit `https://sc2tools.com/sitemap.xml`** in Search Console.

## Running the backfill

The backfill walks recent `game_details` newest-first and writes samples for
games synced before capture existed.

- **Throughput:** at most 2 games per second.
- **Locking:** it holds an advisory lock in `jobLocks`.
- **Resumable:** its cursor is saved, so a stop or restart picks up where it
  left off.
- **Off by default:** it never starts on its own.

To run it:

- From **`/admin/guides` → Stats & backfill**: choose how many days back
  (1–400, default 90) and press **Start**. **Stop** pauses it.
- Or through the API with an admin session token:

  ```bash
  curl -X POST https://api.sc2tools.com/v1/admin/guides/backfill \
    -H "Authorization: Bearer <admin Clerk JWT>" -H "content-type: application/json" \
    -d '{"action":"start","days":90}'
  curl https://api.sc2tools.com/v1/admin/guides/status -H "Authorization: Bearer <admin Clerk JWT>"
  ```

At 2 games/s, 100k games take about 14 hours. The ingest path is unaffected.
`SC2TOOLS_GUIDE_BACKFILL_DISABLED=1` makes Start answer 409.

**Recompute now** (`POST /v1/admin/guides/recompute`) runs the stats job
immediately and then pings the web to revalidate.

## Operations

- **Index:** the stats job starts every aggregation with an indexed
  `$match` on the partial games index `guide_stats_build_opp_race`
  (`{myBuild, opponent.race}`). All other games indexes start with
  `userId`, so none of them can serve a cross-user aggregate.
- **Measured runtime:** about 25 s for 300k games plus 150k samples on the
  test server. It scales linearly, projecting about 85–100 s for 1M games.
  Each aggregation has a 120 s `maxTimeMS` limit.
- **Metrics:** `sc2tools_guide_samples_{captured,skipped,failed,dropped}`
  on `/v1/metrics`.
- **Caching:** public responses send
  `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`.
  Web pages cache API data for 6 hours, and the revalidation ping clears it
  after each stats run.
