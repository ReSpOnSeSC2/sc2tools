# ADR 0053: Opt-in Twitch predictions and game markers

Status: implementation in progress

The Wave 4 `twitch-predictions-markers` item adds optional Twitch channel-points predictions and stream markers to the existing game lifecycle. Both preferences default to false. This work adds no infrastructure, model or external analysis service. Development and tests use synthetic owners, mocked Twitch and disposable Mongo only.

## Consent and provider identity

Prediction authorization is an incremental Twitch OAuth purpose requiring `channel:manage:predictions`. Markers use `channel:manage:broadcast`. Reconnection must preserve a separately consented same-account streaming grant when its required scopes remain present. Provider credentials remain in the encrypted vault. The existing distributed connection lease covers authorization checks, provider requests and journal commits; no provider mutation is replayed after callback entry.

The Settings card is limited to verified affiliate/partner broadcasters. A saved toggle alone does not prove provider consent, a live channel, a valid current connection or eligible SC2 game metadata. Each provider operation checks those conditions again.

`TWITCH_AUTOMATION_ENABLED` is a separate server-owner gate and defaults to false. It accepts only the exact `true` value. With the gate off, lifecycle hooks, recovery and control actions perform no Twitch operations, including when old user preferences contain true opt-ins. Status explicitly reports `server_not_enabled`. No environment, provider account or integration has been enabled during implementation or verification. Owner enablement remains a separate operational action.

## Current ranked-game capability

The current desktop `LiveGameState`, `GET /game` parser and emitted envelopes include a player roster, replay/observer flags, source timestamps and game keys. They do **not** include trustworthy ranked/unranked/custom queue evidence. Pulse ladder ratings and historical replays do not establish the current game's queue.

Automatic predictions therefore fail closed with `ranked_status_unavailable` on current desktop telemetry. The UI and Help must state this limitation. Separately validated server queue evidence is an explicit input to the policy; raw envelope `isRanked`, queue strings, MMR and historical profiles cannot supply it. Current production wiring must pass no ranked evidence until an actual supported source can validate it end to end. Known live two-human 1v1 starts can still create opted-in markers.

Only fresh accepted device events are eligible. Synthetic/test events, replay/observer sessions, ambiguous local-player identity, team/AI games, stale buffered events and browser diagnostics cannot create provider objects. Predictions belong to the real loading event; markers belong to the real start event.

## Durable receipts

A bounded metadata collection records one receipt per owner/game. Prediction and marker lanes have separate states and CAS leases. A unique owner/game index suppresses duplicate delivery; TTL removes old terminal metadata; an indexed next-check time supports bounded recovery. Owner/opponent metadata supports a ten-minute rematch cooldown under the same distributed provider lease.

An external create is durably marked `creating` before its request. If its outcome is uncertain, it becomes `unknown`; it never returns to pending, blindly POSTs again or adopts an arbitrary matching provider object. Known provider/outcome IDs are immutable. A known-ID ambiguous PATCH can be reconciled with that exact provider ID. Expired workers cannot finish a newer lease.

Fresh pending reservations have a 30-second dispatch grace. Recovery inspects them only after that deadline and abandons them with a pending-only CAS. A stale recovery snapshot can never install cancellation intent or skip a marker after a live worker has claimed `creating`; expired pending rows can no longer enter CREATE.

Markers reserved at loading wait for the actual game start. Recovery cannot create them from an old start. A verified replay result resolves a matching prediction; games under 60 seconds, no result within 20 minutes and explicit Dock cancellation request refunds. Recovery is capped at 25 receipts per pass and must not query the replay corpus.

Settlement intent is persisted before provider work and survives a result or cancellation arriving during CREATE. Cancellation is admitted atomically before a resolution dispatch; a late Cancel cannot overwrite an already dispatched resolution or claim a refund. Missing prediction IDs disable the refund CTA and require a manual provider check. A partial known prediction ID may be canceled, but missing outcome IDs never authorize resolution or later adoption of guessed IDs. An unresolved partial receipt requests a timeout refund.

Background operations use the existing owner data-mutation lease so full erasure drains them before deleting account data. The journal is purge-only operational state: full erasure removes that owner's receipts, while export/restore never replays provider operations. A same-broadcaster reconnect can renew the stored connection revision under its current verified provider lease; a replacement broadcaster cannot use old controls. Recovery delays disconnected owners to avoid starving a bounded batch.

Replay settlement is independent of an open Socket.IO overlay and active overlay tokens. It accepts only a newly inserted fresh replay from the existing ingest selection, and additionally checks exact opponent/matchup hashing plus the replay `startedAt` within two minutes of the loading receipt. The older name-only broker correlation is insufficient by itself. Current production loading events still supply no trusted queue evidence.

## References

- [Twitch Predictions](https://dev.twitch.tv/docs/api/predictions): one active prediction; affiliate/partner eligibility; separate prediction scope.
- [Create Prediction](https://dev.twitch.tv/docs/api/reference#create-prediction) and [End Prediction](https://dev.twitch.tv/docs/api/reference#end-prediction): provider limits, outcome IDs, explicit resolve/cancel states and refunds.
- [Stream markers](https://dev.twitch.tv/docs/api/markers): broadcast scope, live/VOD requirements and description limit.

The application window is intentionally narrower than Twitch's provider maximum: 30–300 seconds, default 120. Rendered titles are bounded to 45 Unicode characters and markers to 140.

## Verification so far

Pure preference, rendering and eligibility policy plus real local-Mongo receipt tests cover disabled defaults, strict bounds, malformed inputs, rank-unknown behavior, replay/observer/team/test/stale guards, concurrent claims, exact owner/game scope, stale leases, uncertain creates, immutable IDs, recovery batches and marker start waiting. Runtime wiring, OAuth/UI integration and combined final gates remain required before this feature is complete.
