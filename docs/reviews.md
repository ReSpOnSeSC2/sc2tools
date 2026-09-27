# Replay Review Exchange

Players post one of their games with a question. Other players answer with
comments pinned to exact moments on the replay timeline and, when the game has
map playback, to points on the 2D map. Reviewer leagues are verified from their
own synced games, helpful reviewers earn karma, and Coaching Locker coaches get
a "Book a lesson" entry point.

- **API:**
  - `apps/api/src/services/reviews.js` (requests, board, scoped grant,
    comments, karma ledger, blocks, moderation hooks, GDPR, weekly digest)
  - `services/reviewerReputation.js` (verification, badges, coach badge,
    leaderboard)
  - `services/reviewRedaction.js` (the only place that decides what a public
    payload may contain)
  - `services/notifications.js` (the in-app bell)
  - `routes/reviews.js`, `routes/notifications.js`
  - `jobs/reviewDigestJob.js`
- **Web:**
  - `app/reviews/page.tsx` (board)
  - `app/reviews/[id]/page.tsx` (review page, SEO)
  - `app/reviews/[id]/opengraph-image.tsx`
  - `components/reviews/*`
  - `components/notifications/NotificationBell.tsx`
  - `lib/reviews.ts`, `lib/reviewMarkdown.tsx`, `lib/reviewJsonLd.ts`,
    `lib/replayMarkers.ts`
- **Thresholds:** every number below lives in `REVIEWS` in
  `apps/api/src/config/constants.js` (web mirrors in `lib/reviews.ts`).

## Rollout

| Stage  | API `REVIEWS_ENABLED` | Web `NEXT_PUBLIC_REVIEWS_ENABLED` | Who sees it |
| ------ | --------------------- | --------------------------------- | ----------- |
| Off (default) | unset / `off` | unset / `off` | Nobody. Every `/v1/reviews*` route 404s; pages 404; no nav, bell or sitemap entries. |
| Admins | `admins` | `admins` | Platform admins only. The API 404s everyone else, and pages load client-side with the admin's token and stay `noindex`. |
| Everyone | `on` | `on` | Public. The board and answered reviews go into the sitemap. |

- Set both flags together. The web flag is inlined at build time, so a
  Vercel redeploy is needed after changing it.
- The API flag is the security boundary.
- The weekly digest job only runs when the API flag is `on`.
- **Launch seeding:** ask a few high-league friends to answer the first real
  requests. Never post fabricated requests or reviews; every page is real
  data.

## Privacy model

- **The opponent never consented and is never identifiable.**
  - Public payloads never carry their display name, BattleTag, clan, toon
    handle, pulse id or character id, exact MMR, stream links, the APM
    curve (it names players) or `player_stats`.
  - The opponent appears only as `Opponent (Zerg, ~4,100 MMR)`. MMR is
    always rounded to 100.
- **`gameId` is private.** Agents that can't read a replay's native id build
  one as `date|OpponentName|map|length`, so the id never appears in any
  public response. Requests have their own random 16-character ids.
- **The asker chooses how they appear.**
  - They post as "Anonymous <Race>" (the default) or under their display
    name.
  - Named mode uses the display name only, never the BattleTag fallback
    other surfaces use. An in-game name, plus the map and result, could
    locate the game (and so the opponent) in public ladder history.
  - The asker's own replies always show the request's asker label, never
    their profile.
- **No replay file.** The original `.SC2Replay` contains every player's
  identity, so review pages never offer it.
- **No chat.** Chat is not extracted from replays, so there is nothing to
  redact. Keep it that way.
- **Allow-lists everywhere.** Every public payload is rebuilt from an
  allow-list, never by spreading service output, so a field added upstream
  can't leak by default.
  - Map playback keeps only the known v3–v7 keys and strips identity-shaped
    keys at any depth.
  - Segmented playback bytes are integrity-hashed by the agent and can't be
    rewritten. The API parses each segment and refuses to serve one
    containing an identity-shaped key (fail closed).
  - The segment manifest carries the replay file's SHA-256. That is not an
    identity, but someone holding the same file could confirm it's the same
    game.
- **Tests.** `apps/api/__tests__/reviewsPrivacyAndGrant.test.js` seeds a
  known opponent name, BattleTag, clan, pulse id, toon handle and character
  id into every layer (slim row, macro breakdown, APM curve, map playback,
  game id). It asserts that none appear in any public response, `/og`
  payload, sitemap, leaderboard, `/me/reviews` or notification.

### The scoped grant

- An **open or answered** request grants read-only access to that one game's
  analysis (macro breakdown, build order, map playback) through
  `/v1/reviews/:id/analysis*`. Nothing else of the owner's can be reached:
  - The routes take no game id.
  - Every read goes through `replayLibrary.getDetail(ownerId, gameId)` with
    the ids stored on the request.
- **Closing revokes the grant.** Once the asker (or a moderator) closes the
  request, the analysis routes answer `410`. The question and comments stay
  readable. Closed requests are `noindex` and leave the sitemap.
- **Deleting the game closes the request.** This covers a history wipe, a
  single-game removal and a resumed-replay quarantine, and is detected
  lazily on the next grant check too.
- **Caching.** Analysis JSON is cached for at most 60 s (`max-age=60`, and
  `s-maxage=60` in shared caches). Playback segments are cached by the
  browser only (`private, max-age=3600`), so a revocation doesn't linger in
  shared caches.

## Rules

### Asking

- **Eligible games.** You can only post your own **1v1** game with a known
  matchup and a macro breakdown. Map playback is optional but boosts
  ranking.
- **Question:** 20–500 characters, run through `contentFilter`.
- **Optional details:**
  - Focus tags: build order, macro, scouting, army control, decision
    making, micro, specific timing.
  - A time range.
  - A desired reviewer level: anyone, my league or higher, or Masters+.
  - Visibility: public board, or link only (unlisted, never indexed).
- **Limits.**
  - At most **3 open** requests per user and **3 new per day**.
  - One live request per game, enforced by a unique `activeKey`.
- **Squads.** The prompt's "squad only" visibility doesn't exist, because
  there are no Squads on the platform yet.

### Commenting

- **Who can comment.** You need a website sign-in (agent device tokens are
  refused) and **at least 20 synced games**. The asker is exempt.
- **Desired level.** The asker's desired level gates **top-level reviews**.
  Replies are open to every eligible user.
  - "My league or higher" means a verified band at or above the band the
    asker played at in that game.
  - "Masters+" means a verified band of Master or Grandmaster.
- **Content.**
  - 10–2,000 characters, at most 5 links, run through `contentFilter`.
  - The web renders a safe markdown subset as React elements, never HTML:
    bold, italic, code, lists, quotes, and links (`rel="nofollow ugc"`,
    http(s) only). Game-clock times like `5:12` become seek chips.
- **Pins.**
  - Every comment pins a moment (`gameTimeSec`), optionally a range of at
    most 5 minutes.
  - When there is playback, a comment can also pin a world point on the
    map.
- **Replies.** Threads go one level deep.
- **Rate limits.** 30 comments per hour and 200 per day, counted in Mongo
  so they survive restarts, plus a per-user burst limiter. There are at
  most 500 comments per request.
- **Editing and deleting.**
  - You can edit your own comment for **15 minutes**.
  - Deleting a comment that has replies leaves a `[deleted]` placeholder;
    otherwise the comment is removed.
  - Either way, the karma it earned is revoked.

### Blocks

- Anyone can block a comment's author:
  - Their comments are hidden from the blocker. A comment with replies
    shows a placeholder.
  - They can't comment on the blocker's requests.
- Blocks are created from a comment, because internal user ids never
  reach the client. They're managed at `GET/DELETE /v1/me/review-blocks`.

## Reputation

### Karma ledger

`review_karma_events` is an append-only ledger with a unique key of
`{commentId, kind, actorId}`, so repeating any action is a no-op.

| Event | Points | Who can do it |
| ----- | ------ | ------------- |
| `helpful` | +5 | The asker. Reversible. |
| `best` | +15 | The asker. One per request; moving it moves the points. Sets the request to `answered`. |
| `upvote` | +1 | Any signed-in user except the author, capped at +10 per comment. The cap slot is reserved atomically; withdrawing a vote frees it. There are no downvotes; use Report. |
| `removed` | −20 | Moderation, once per comment. The comment's earned helpful, best and upvote karma is revoked too. |

- Totals are materialised on `users.reviewer`. `ReviewerReputationService.recomputeStats` rebuilds them from the ledger when they drift.
- **Badges** are derived on read, never stored:
  - **First Review:** 1 or more reviews
  - **Helpful ×10:** 10 or more helpful marks
  - **Mentor:** 50 or more helpful marks
  - **Best Answer ×10:** 10 or more best answers
- **Flair** combines the verified league with the top title, e.g.
  "Masters Mentor" or "Diamond Top Reviewer".
- **Leaderboard.** A weekly leaderboard (ISO week, UTC) lists reviewers who
  opted in to show their name. Everyone else's karma still counts toward
  their own badges.
- **Profile.** A public `/p/<handle>` profile gains a reviewer section once
  its owner has reviewed: karma, best answers, badges and matchups
  reviewed.

### Verified league

- The verified league comes from the reviewer's **own synced ladder 1v1
  games** in the current or previous season. The window starts at the
  previous season's start from the SC2Pulse catalog, with a 180-day
  fallback.
- **Per race:**
  - The race needs **10 or more games**.
  - The band is the one reached by the race's **3rd-best** game, so a
    single outlier or a corrupt row can't verify anyone upward.
- The reviewer's best race wins. Without enough games, the reviewer is
  "Unverified".
- The result is cached on `users.reviewer.verified` for 12 hours.
- **Bands** use the ladder `leagueId` numbering (0 Bronze … 6
  Grandmaster), from MMR floors in `util/leagueBands.js`.

### Coach badge

- **Who gets it.** Coaching Locker coaches linked to a site account. The
  Locker is invite-only.
- **"Book a lesson".** The link appears when the coach has published,
  unpaused availability:
  - For the coach's own attached students, it goes straight to
    `/coaching?view=schedule`.
  - Booking is attachment-gated, so for everyone else it sends the coach
    an in-app lesson request (at most 5 per day per user). The coach can
    then attach the player in the Locker, which opens their published
    calendar.

## Moderation playbook

- **One queue.** Reports use the one existing queue: `community_reports`,
  `/v1/community/admin/reports` and the web page `/admin/moderation`.
- **Target types.** Review requests and comments are registered report
  targets (`review_request`, `review_comment`). Each report row carries a
  `target` summary with the title, snippet, a link to the content in
  context, and whether it is hidden.
- **Auto-hide.** When **3 different people** have open reports on the same
  item, it is hidden automatically, pending review.
  - **Hidden comments:** visible to their author (marked "Hidden pending
    moderator review") and to admins.
  - **Hidden requests:** visible only to the asker and admins. They leave
    the board and the sitemap, and their scoped grant is suspended.
- **Dismiss.** Restores auto-hidden content and resolves **every** open
  report on that target.
- **Remove.**
  - Requests become `removed`: gone for everyone but admins, and the grant
    is revoked.
  - Comments become `removed`: a "[removed by a moderator]" placeholder
    stays only if they have replies. The author loses the comment's earned
    karma, and −20 is applied once.
- **What to remove:** harassment, slurs, spam and off-topic content, plus
  **anything that identifies the opponent**, e.g. a comment naming them or
  linking their stream. Reporters can pick "Reveals someone's identity".
- **What to dismiss:** disagreements about strategy. Use upvotes and
  helpful marks for those, not moderation.

## Notifications

- **Storage.** In-app only: `notifications` plus the header bell. There is
  no email provider.
- **What notifies whom:**
  - The asker gets new reviews, grouped: one unread row per request, e.g.
    "3 new reviews on your replay".
  - A reviewer gets their review marked helpful or best, replies (grouped
    per review), and lesson requests (coaches).
  - Verified reviewers get a weekly digest, "N open review requests in
    your matchups" (their race, at or below their band). It is sent once
    per ISO week after Monday 15:00 UTC. Opt out from the leaderboard card
    on `/reviews`.
- **Live updates.** The socket push to `user:<id>` is a text-free
  `notifications:changed` ping. OBS overlay and desktop-agent sockets share
  that room, and the bell refetches over REST.
- **Retention.** Notifications expire after 90 days (TTL index).

## SEO and sharing

- **Canonical URL:** `/reviews/<id>`. Titles look like `[PvZ] Why did my
  blink all-in fail? — Replay Review · SC2 Tools`. The codebase uses
  "· SC2 Tools" suffixes, never "| SC2 Tools".
- **Quality gate.** A review page is indexable only once the thread has a
  **helpful or best** review. Before that it is `noindex, follow`.
  Link-only and closed requests are never indexable.
- **JSON-LD.** Indexable pages carry QAPage JSON-LD: a Question with
  `answerCount`, `acceptedAnswer` set to the best review, and
  `suggestedAnswer` set to the helpful reviews. They also carry a
  BreadcrumbList. User text is escaped against `</script>` break-out.
- **Sitemap.** The dynamic sitemap (`app/sitemap.ts`) adds `/reviews` and
  every indexable review, regenerated hourly.
- **Sharing:**
  - A dynamic OG image shows the matchup, a question snippet, the review
    count, the map thumbnail and the best-answer tick.
  - "Post to Reddit" pre-fills `[PvZ] … — timestamped replay review`.
  - "Copy for Discord" copies a message with the link.

## GDPR

- **Export.** `GET /v1/me/export` includes the user's review requests,
  comments, karma received, blocks and notifications. Other people's ids
  are removed. These are never restorable from a backup.
- **Account deletion:**
  - The user's requests are deleted, along with the threads under them.
  - Comments they wrote on other people's requests are anonymised to
    "[deleted user]".
  - The karma they received, their blocks (both directions) and their
    notifications are deleted.
  - Karma they gave stays with its recipients, without the actor id.
- **History wipe.** Closes every active request whose game is gone.

## API

- **Public** (a valid Bearer only personalises; lists send `Cache-Control:
  public, s-maxage=60`):
  - `GET /v1/reviews` (`sort=hot|new|top`, `matchup`, `band`, `tag`,
    `unanswered`, `cursor`)
  - `GET /v1/reviews/leaderboard`, `GET /v1/reviews/sitemap`
  - `GET /v1/reviews/:id`, `GET /v1/reviews/:id/og`
  - `GET /v1/reviews/:id/analysis`
  - `GET /v1/reviews/:id/analysis/map-playback`, plus
    `/manifest` and `/artifacts/:artifactId/segments/:index`
- **Signed in** (Clerk browser session):
  - `POST /v1/reviews`
  - `GET /v1/reviews/for-me`
  - `POST /v1/reviews/:id/close`, `POST /v1/reviews/:id/report`
  - `POST /v1/reviews/:id/comments`
  - `PATCH /v1/reviews/:id/comments/:cid`,
    `DELETE /v1/reviews/:id/comments/:cid`
  - `POST /v1/reviews/:id/comments/:cid/{helpful,best,upvote,report,block}`
    (`{value:false}` undoes helpful, best and upvote)
  - `POST /v1/reviews/coaches/:coachId/lesson-request`
  - `GET /v1/me/reviews`, `GET|PATCH /v1/me/reviewer`
  - `GET /v1/me/review-blocks`, `DELETE /v1/me/review-blocks/:id`
  - `GET /v1/me/notifications`, `GET /v1/me/notifications/unread-count`,
    `POST /v1/me/notifications/read`
