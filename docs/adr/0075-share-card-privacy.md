# ADR 0075: Share cards never identify another player

Status: Accepted, November 9, 2026. Implemented in the web app with this
change. No API, database, flag or infrastructure change.

## Context

- A share card is a 1200×630 PNG plus the text posted with it. Three surfaces
  make one: Arcade rounds (`ModeRunner` hands each mode's `share()` to
  `shareCard`), the Season Recap and the per-game battle card. All three
  deliver through `deliverShareCard` in
  `apps/web/components/analyzer/arcade/ShareCard.tsx`.
- Until now a card printed what the private analyzer shows: opponents' display
  names (six Arcade modes, Buildle's case file, three Two Truths facts, the
  recap's nemesis and upset), the opponent's exact MMR (battle card) and game
  times to the second (Comeback Count, Streak Veto).
- The opponent is a third party who never agreed to appear in a post.
  `docs/reviews.md` and ADR 0065 already apply that reasoning to public reviews
  and player pages. Share cards had no rule.
- Every card also carried `sc2tools.com/arcade`, as a link in its text and a
  watermark on its image, and no page existed there.

## Decision

1. **No identity.** Nothing exported carries another player's display name, raw
   name, battle tag, toon handle, SC2Pulse id or game id. A card says "Rival A",
   "Game B" or "Loss C" (lettered in the order the round showed them) or "a Zerg
   opponent". In-app views are unchanged.
2. **No recoverable rating.** A rating gap is rounded to the nearest 100 on
   every card, so no card, alone or added to another, narrows another player's
   rating below a 100-wide band. The sharer's own MMR may be printed. A value
   outside the ladder range (500 to 9999; 0 means "not recorded") counts as
   unknown, because as an operand it turns a gap into the other player's rating.
3. **Day, not second.** A card dates a game to the day.
4. **One place decides.** A mode's `share()` is the only source of card text.
   The runner's fallback is the mode blurb plus a fixed outcome line, never
   `score.note`, which is written for the in-app reveal and may name the
   opponent. The helpers live in `apps/web/lib/sharePrivacy.ts`.
5. **A dismissed share sheet is not a share.** `deliverShareCard` stops on
   `AbortError` instead of falling through to the clipboard or a download.
6. **Counts only.** The `card_shared` analytics event carries the card kind, the
   delivery path, the built-in Arcade mode id and a normalized page location.
   Nothing from the card.
7. **The printed address works.** `/arcade` redirects (307) to `/try` when
   `NEXT_PUBLIC_INSTANT_IMPORT` is `all`, otherwise to `/`, until a public
   Arcade page replaces the rule. `SHARE_LINK_URL` is unchanged, because cards
   already posted carry it.

## Consequences

- A card loses the rival's name and the exact gap. The app keeps both.
- `apps/web/components/analyzer/arcade/__tests__/sharePrivacy.contract.test.ts`
  plays all 18 modes against sentinel opponents and fails on any name, id,
  exact rating or time of day. A new mode is covered without further work. A
  fact or note that names an opponent in the app must supply share wording.
- Cards posted before this change are not affected.

## Not decided here

- A day, a map and a matchup can still point at one game for someone who
  already knows the sharer. No card names anyone.
- Copy tools on the private game page (battle report copy, build-order export)
  still name the opponent. They are not share cards.
- The recap prints the sharer's own account label.
- Whether analytics events other than `card_shared` send raw per-record
  addresses.
