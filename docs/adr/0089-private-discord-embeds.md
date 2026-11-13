# ADR 0089 · Private data in Discord embeds

## Decision

- Discord channel posts contain text embeds with known races, bounded rating values and measured records. Automatic posts omit opponent identity and rating, raw map/build labels, precise replay timestamps and game links.
- A channel's previous MMR boolean could be an implicit default. Store a separate consent generation when the owner actively selects **Share my MMR**. A queued rating post needs that same generation at dispatch.
- **Ladder milestones from your inbox** starts off per channel. Only stored ladder bell rows with a recognized kind and exact safe headline can enqueue. Dispatch rechecks the private milestone preference and mute list. Existing promotion, personal peak, weekly and completed-session events keep their own keys.
- Manual battle report posting retains the active public share link. The API checks ownership and current consent and supplies fixed embed text. Existing clients may still send a headline and paragraph, which are ignored.
- Pending rows created before this policy lack the embed policy marker. The new drainer retires them and keeps their dedupe receipts until the existing TTL. Already delivered Discord messages remain on Discord.

## Rollout

The settings view waits for the API's private-embed capability before offering new controls. The API keeps legacy options in the response for already-open Settings clients. Requests using the old default MMR field cannot opt in. Deploy both on the same main revision and keep the new API for the privacy policy. In a rollback to the older drainer, disable Discord delivery before restarting that version because it can still send pre-policy rows.
