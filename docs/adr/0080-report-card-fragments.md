# 0080. Share replay report cards in URL fragments

Date: 2026-11-11

## Context

Players can export an image or text summary of the local replay report. A share link should make the same selected aggregate rows readable without uploading a replay or storing a report on a server.

## Decision

- Serve an unindexed static viewer at `/card/report/summary`. The route segments identify fixed enums. The browser decodes the fragment and draws the existing report card.
- Encode the version, card type, section flags, bounded integers, race indexes and an opener index in a fixed varint layout. The base64url fragment stays under 60 characters. Version 1 opener indexes use a frozen catalog table so changes to build names or sorting cannot reinterpret old links.
- Reject unrecognized sections, indexes, invalid count relationships, noncanonical encodings, extra bytes and oversized fragments. The wire format has no place for names, free text, accounts, replay IDs or individual games. Render a neutral error without echoing rejected input.
- Identify cards as self-reported. Reuse the local replay shell so the viewer needs no Clerk handshake or error telemetry. Normalize viewer analytics to `/card/:type/:class`. The fragment never goes to the server, and the viewer is excluded from the sitemap.

## Consequences

Anyone with the link can see the aggregates and forge valid values. The report link is neither a private record nor proof of a game result. New formats must preserve the v1 table and decoder for existing links. An opener added after the v1 table was frozen must be left out of a v1 link.
