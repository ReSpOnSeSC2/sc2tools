# 0080. Share replay report cards in URL fragments

Date: 2026-11-11

## Context

Players can export an image or text summary of the local replay report. A share link should make the same selected aggregate rows readable without uploading a replay or storing a report on a server.

## Decision

- Serve an unindexed static viewer at `/card/report/summary`. The route segments identify fixed enums. The browser decodes the fragment and draws the existing report card.
- Encode the version, card type, section flags, bounded integers, race indexes and an opener index in a fixed varint layout. The base64url fragment stays under 60 characters. Version 1 opener indexes use a frozen catalog table so changes to build names or sorting cannot reinterpret old links.
- Use version 2 only when the sharer selects a complete Commander ID. Its additional section is one bounded index into the frozen taxonomy order. The original summary and comparison encodings stay on version 1.
- Reject unrecognized sections, indexes, invalid count relationships, noncanonical encodings, extra bytes and oversized fragments. The wire format has no place for names, free text, accounts, replay IDs or individual games. Render a neutral error without echoing rejected input.
- Identify cards as self-reported. Reuse the local replay shell so the viewer needs no Clerk handshake or error telemetry. Normalize viewer analytics to `/card/:type/:class`. The fragment never goes to the server, and the viewer is excluded from the sitemap.
- Serve `/card/report/compare` as a second static, unindexed class. Visitors can compare the shared card with a summary link they paste locally. The comparison uses a distinct type byte and exactly two records of games, wins and losses. Both records require a positive game count. A forwarded comparison labels the records A and B.
- Generate separate static social preview images for the summary and comparison classes. The preview uses fixed class copy. The fragment is decoded only in the viewer.

## Consequences

Anyone with the link can see the aggregates and forge valid values. The report link is neither a private record nor proof of a game result. New formats must preserve the v1 table and decoder for existing links. An opener added after the v1 table was frozen must be left out of a v1 link.
