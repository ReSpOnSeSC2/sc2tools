# ADR 0110: The raid finder has its own connect and gates

Status: Accepted, November 28, 2026. Adds `apps/api/src/services/twitchRaids.js`,
`twitchRaidPolicy.js`, `twitchRaidProvider.js`, `twitchPurposes.js`,
`routes/twitchRaidRoutes.js` and the Stream Dock's Raid a channel panel.

## Context

- Twitch's `POST` and `DELETE helix/raids` need the `channel:manage:raids`
  scope. A 200 only means the raid was queued; Twitch counts down 90 seconds and
  does not tell the caller whether it went. Twitch allows 10 requests every 10
  minutes and answers 409 while another raid is queued.
- Predictions, markers and reward actions already follow one pattern for
  actions taken on a streamer's behalf: a separate connect for each permission,
  a server gate that starts off, the streamer's own switch that starts off, a
  receipt, and no second create after an answer that was not confirmed.
- Kick has no raid or host call.

## Decision

1. Raids are a fourth Twitch connect purpose (`raids`, consent `raidsConsent`),
   listed with the others in `twitchPurposes.js`, so approving one permission
   never grants another. The server gate is `TWITCH_RAIDS_ENABLED` (off), the
   streamer's switch is `preferences.twitchRaids.enabled` (off), and neither is
   writable through the generic preferences route.
2. Candidates come from `LiveStreamsService.list()`; nothing calls a provider a
   second time. The list shows with links whatever the gates say. Ranking: 20
   viewers or fewer first, then channels the streamer raided or was raided by
   (newest first), then the rest, smallest first; the streamer's own channel is
   never offered. The Twitch user id is read from the server's own copy of the
   list, never sent by the browser.
3. Start writes a `pending` receipt before Twitch is called, then records
   `queued`, `failed` (Twitch refused) or `unconfirmed` (no clear answer). An
   unconfirmed raid is never sent again by the server, and a start is refused
   while a raid from the last three minutes is queued. A pending receipt that
   never got an answer is shown as unconfirmed. Cancel sends `DELETE` and
   records `canceled`, or `closed` when Twitch has no raid left.
4. History (the last 30 raids sent and received) lives on the user document, so
   account export and erasure already cover it. Incoming raids reach it from
   the stored platform event, only while the switch is on. A queued raid stays
   "Queued": the history never claims it finished.
5. The panel is a separate chunk, loaded only when Stream ending is the active
   scene, so the Dock's first load does not grow.

## Consequences

- One more write permission to approve, by design; reconnecting it is one
  click in Settings.
- Channels are matched to raid history by display name, since a raid event
  carries no stable id; two channels renamed to each other's names would share
  history, which only changes their order.
