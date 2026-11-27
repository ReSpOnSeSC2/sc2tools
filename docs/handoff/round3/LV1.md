# LV1: live StarCraft II streams

**Shipped (stacked on #998, RZ1, which sits on #997, #996, #995).** A public `/live` page lists every StarCraft II stream that is live now on Twitch and Kick: title, channel, language, viewers, live time. Three menus filter by platform and language and order by viewers or small channels first. Cards open the channel on its own site. `GET /v1/live-streams` is public, rate limited and read from a server copy (ADR 0108); `LiveStreamsService.list()` is the one reader for other server code.

**Decisions.**
- Filters run in the browser on the one cached list; the page never calls a provider.
- An expired list is served at once and refreshed behind the caller; each platform gets 8 s, so a hanging one cannot turn a usable list into an error.
- 503 only when every configured platform failed and no earlier list is left.
- Category ids (Twitch game, Kick name lookup) are shared with channel setup in `sc2Categories.js`.
- `/live` is static and loads only its own code: 122 kB first load (budget 140); local perf:budget reads three older routes over budget, as on the stacked base.

**Review round.** 18 findings, all real and fixed: stale-while-revalidate, language that dropped out of the list, focus after Show all and Retry, empty and degraded wording, repeated Twitch ids, skeleton that now draws the real (disabled) menus, filters rebuilt as three equal menus (first card now at y 431 on a 360 px phone, was 797), non-breaking title, split `readStream`, abort-listener cleanup, one `rateLimit` import with no cast.

**Tests.** API liveStreams + streamingChannel 45/45; web live files 30/30 (vitest); tsc, eslint, ui-lint clean. Mutations 10/10 killed (one survivor, reset focus, got a test; second run in `.cache/round3-LV1-tools/mutation-02`).

**Seen.** Built app, signed out, Playwright at 360, 768 and 1280, light and dark: loading, ready, degraded, empty, filtered-empty, unavailable. No sideways scroll; skeleton and ready layouts line up.

**Not verified.** Playwright e2e spec (`live-streams.spec.ts`, with accessibility check) not run locally; real Twitch and Kick calls not made (mocked fetch only); the 768 dark picture and the filtered/unavailable pictures at 360 were measured but not all opened.

**Follow-ups.** Raid finder can read `list()`. Ledger: none.
