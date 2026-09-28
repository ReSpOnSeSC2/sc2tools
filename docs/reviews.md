# Replay Review Exchange

Players post one of their games with a question. Other players answer with
comments pinned to exact moments on the replay timeline and, when the game has
map playback, to points on the 2D map. Reviewer leagues are verified from their
own synced games, and helpful reviewers earn karma.

- **API:**
  - `apps/api/src/services/reviews.js` (requests, board, scoped grant,
    comments, karma ledger, blocks, moderation hooks, GDPR, weekly digest)
  - `services/reviewerReputation.js` (verification, badges, leaderboard)
  - `services/reviewRedaction.js` (the only place that decides what a public
    payload may contain)
  - `services/notifications.js` (the in-app bell)
  - `routes/reviews.js`, `routes/notifications.js`
  - `jobs/reviewDigestJob.js`
- **Web:**
  - `app/reviews/(board)/page.tsx` (board)
  - `app/reviews/mine/page.tsx` ("My reviews": your requests, your
    reviews, and blocked reviewers with Unblock)
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
- **No private build names.** A build or opponent-strategy label written
  by the asker's own custom build library is a private, user-authored name.
  A distinctive one could be matched to their public profile or published
  builds, so requests only ever show the shared agent/community label, or
  nothing.
- **The replay file is opt-in.** The original `.SC2Replay` contains every
  player's in-game name, the opponent's included, so it is never offered by
  default.
  - The asker can tick "Let reviewers download the replay file" when
    posting, and switch it on or off later on the request page. The form
    and the switch both warn that the file names both players, including
    the asker, even when posting anonymously.
  - Only signed-in website users can download it, only while the request is
    open and not hidden. Each click gets a fresh short-lived signed link
    (`GET /v1/reviews/:id/replay`), so turning sharing off takes effect
    immediately.
  - The file is served as `sc2tools-review-<id>.SC2Replay`. The normal
    download name includes the opponent's name.
- **No chat.** Chat is not extracted from replays, so no review page or
  payload shows it. The raw file offered only when the asker opts in (see
  above) does contain the game's chat, and the opt-in warning says so.
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
  - Deleted comments still count, so deleting can't reset the limit.
  - Every limit is re-checked after the insert (and the insert withdrawn
    if it went over), so parallel posts can't slip past it. The same
    applies to the 500-comment thread cap and the 3-open / 3-per-day
    request caps.
- **Editing and deleting.**
  - You can edit your own comment for **15 minutes**.
  - Deleting is always a soft delete: the text, pin and range are wiped
    and the row stays. A deleted comment with replies shows a `[deleted]`
    placeholder; without replies it disappears from the thread.
  - Either way, the karma it earned is revoked.

### Blocks

- Anyone can block the author of a visible reviewer comment. Blocks are
  created from a comment, because internal user ids never reach the
  client. They're listed and undone on **My reviews** (`/reviews/mine`),
  backed by `GET/DELETE /v1/me/review-blocks`.
- The blocker no longer sees the blocked person's comments (a comment
  with replies shows a placeholder) and gets no notifications from them.
  The blocked person can't reply to the blocker's comments.
- On the blocker's **named** requests, the blocked person can't comment.
- On the blocker's **anonymous** requests, a refusal would reveal who the
  asker is. So the blocked person can still comment, but the asker never
  sees those comments and is never notified about them.
- **Blocks made as an anonymous asker are private.** A block the asker
  makes on their own anonymous request is stored with
  `origin: "anonymous_request"`. It hides the blocked person's comments
  and notifications from the asker everywhere, but is never enforced as a
  refusal the blocked person could see: replies, the asker's named
  requests, or "Requests you can help with". Blocking the same person
  again from a named context makes it an ordinary block.
- Comment bodies are validated before any block check, so an invalid
  throwaway comment can't be used to test who has blocked you.
- **The asker is never blockable from their own request**, and a viewer's
  blocks never hide the asker's replies, silence their reply
  notifications, or drop an anonymous request from "Requests you can help
  with". Any of these would let someone test whether a named user is the
  anonymous asker.

## Reputation

### Karma ledger

`review_karma_events` is an append-only ledger with a unique key of
`{commentId, kind, actorId}`, so repeating any action is a no-op.

| Event | Points | Who can do it |
| ----- | ------ | ------------- |
| `helpful` | +5 | The asker. Reversible. |
| `best` | +15 | The asker. One per request; moving it moves the points. Sets the request to `answered`. |
| `upvote` | +1 | Any signed-in user except the author, capped at +10 per comment. The cap slot is reserved atomically; withdrawing a vote frees it. There are no downvotes; use Report. The asker's own replies can't be upvoted: karma is public, so it would reveal an anonymous asker's account. |
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

### Coaching stays private

- The review exchange **never reads or writes the Coaching Locker** (the
  `coaching_locker` collection, its roster, calendars or bookings).
- There is no coach badge, "Book a lesson" link or lesson request, so a
  review page never reveals who coaches or who is coached.
- Coaching remains invite-only and role-gated exactly as before. The
  regression test "coaching stays private" in
  `apps/api/__tests__/reviewsReputation.test.js` seeds a Locker coach who
  reviews, then asserts that no Locker data appears on any review
  surface and that the Locker is unchanged afterwards.

## Moderation playbook

- **One queue.** Reports use the one existing queue: `community_reports`,
  `/v1/community/admin/reports` and the web page `/admin/moderation`.
- **Target types.** Review requests and comments are registered report
  targets (`review_request`, `review_comment`). Each report row carries a
  `target` summary with the title, snippet, a link to the content in
  context, and whether it is hidden.
- **Auto-hide.** When **3 different people** have open reports on the same
  item, it is hidden automatically, pending review.
  - Each person can report a given review item **once ever**, so after a
    dismissal the same accounts can't re-hide it; only new reporters
    count.
  - Review items enter the queue only through the review API (with its
    rollout, visibility and own-content checks). The generic
    `POST /v1/community/reports` still accepts only builds and
    opponents.
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
    karma, and −20 is applied once. The asker's own replies carry no karma
    either way, so removing one never changes an anonymous asker's public
    karma.
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
  - A reviewer gets their review marked helpful or best, and replies
    (grouped per review).
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
  - `POST /v1/reviews/:id/replay-sharing` (asker: `{value}`; a moderator
    can only turn it off), `GET /v1/reviews/:id/replay` (signed download
    link when shared)
  - `POST /v1/reviews/:id/comments`
  - `PATCH /v1/reviews/:id/comments/:cid`,
    `DELETE /v1/reviews/:id/comments/:cid`
  - `POST /v1/reviews/:id/comments/:cid/{helpful,best,upvote,report,block}`
    (`{value:false}` undoes helpful, best and upvote)
  - `GET /v1/me/reviews`, `GET|PATCH /v1/me/reviewer`
  - `GET /v1/me/review-blocks`, `DELETE /v1/me/review-blocks/:id`
  - `GET /v1/me/notifications`, `GET /v1/me/notifications/unread-count`,
    `POST /v1/me/notifications/read`
