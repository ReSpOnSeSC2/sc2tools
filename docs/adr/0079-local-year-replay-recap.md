# 0079. Build the local year recap from replay headers

Date: 2026-11-11

## Context

A year recap should work for signed-out players with a large StarCraft II folder. Replay names, account identities and opponent data are private even if a user decides to share a card.

## Decision

- Use the existing browser engine with one worker and a separate level-2 header entry point. Keep the list-players response unchanged. Batch garbage collection for header scans only.
- Use 2026 file modification times as a cheap pre-filter and replay-authored dates as the final UTC year filter. Include only human 1v1 ladder games. Header data cannot identify games resumed from a replay.
- Keep replay files and header results in memory. Serve only static assets and the same-origin browser engine on the recap route. Use the same local identity rules and aggregation as the existing replay tools.
- Give the public card renderer an explicit projection of aggregate numeric fields. Never pass a replay, player, account, map or rating object into the renderer.

## Consequences

The browser avoids a second replay reader and can reuse the existing engine and slide UI. Files whose modification times fall outside 2026 can be missed. An old replay format or missing ladder flag can leave a game out of the recap.
