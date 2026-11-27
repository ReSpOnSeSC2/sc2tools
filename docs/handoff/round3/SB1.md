# SB1: channel tags and the StarCraft II category at game start

**Shipped.** Two switches on the Streams page, both off: channel tags at each game start (Twitch and Kick) and the StarCraft II category at game start. Agent 0.26.0, API routes `POST /v1/agent/streaming/tags` and `/category` (`streamingChannel.js`), ADR 0104.

**Decisions.**
- The server reads and writes the provider; each call answers with a receipt, never an HTTP error, so a failure cannot reach the title path.
- One tag rule for both providers (letters and digits, 25 characters, 10 tags), checked in the agent and again on the server.
- Hand-set tags are kept: the agent saves the tags it wrote last (also when the receipt was lost) and only those are replaced.
- Category is set once per game with the receipt saved first; Kick id is looked up once by name.
- Provider channel read and headers are shared with the title code (`streamingChannelRead.js`); a missing channel row is an observation gap, not a reconnect prompt.
- The preview and cached snapshot show tags only while a game is loading.

**Review fixes.** Unticking game-start titles in flight stops that title; lost receipts keep our tags; no `any` types; one receipt sanitizer; service.py back to 801 lines.

**Counts.** API jest 128/128 (6 suites), tsc clean. Agent: 179 in the stream files, 365 across every test that imports the streaming service. Web help tests 97/97. Mutations 10/10 killed (`.cache/round3-SB1-tools/mutation-01`).

**Not verified.** No live Twitch or Kick call (fakes only); whether Kick returns `stream.custom_tags` and `is_live` as documented; AutoMod rejection gives a generic reason; the Streams page was checked offscreen only.

**Limit.** The live feed carries no map at game start, so `ViewerGames` (a map outside the ladder pool) is rarely sent; the help article, changelogs and ADR say so. Follow-up: a custom-game signal from the agent.

**Ledger.** No roadmap-ledger item advanced.
