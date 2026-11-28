# LP1: What's new on the landing page

**Shipped (stacked on #1000, RZ2).** A server-rendered "What's new" section sits directly above Humdingers on `/`: six cards in three groups, the Randomizer build and unit draws leading. Data is in `apps/web/lib/landingNewFeatures.ts`, markup in `components/landing/WhatsNewShowcase.tsx`.

**Cards and what each claims.**
- Randomizer: build and unit draws per race (live on merge); the desktop loading card draw and lighter cards (Desktop app 0.26.0).
- Stream tools: channel tags and StarCraft II category, Stream Guardian (both Desktop app 0.26.0); game chapters, where the Dock list and copy is live on merge and the YouTube archive write is marked coming soon.
- Live: the `/live` page, marked Coming soon.

**Decisions.**
- Every card carries one availability label (Live now, Desktop app 0.26.0, Coming soon); a test fails if the Live card loses "Coming soon" or a desktop card loses "0.26.0".
- No new client code: plain `next/link` and `next/image`, no `Badge` (a client component). `/` reads 202 kB first load before and after (budget 215).
- Pictures are crops of this chain's own renders with sample data (desktop Streams page, Guardian, loading card; web Randomizer settings, Stream Dock), plus a fresh Playwright render of `/live` from the built app. Each is a PNG under 50 kB, 2:1 canvas for tiles so rows align.
- A lone last card of a three-column group spans the row on a tablet, side by side, instead of sitting half empty.

**Owner actions (gates that start off).**
- `YOUTUBE_CHAPTERS_ENABLED=true` on the server: until then the game chapters card says YouTube is coming soon. Remove the note once it is on.
- Twitch and Kick app credentials for `/live`: until then its card says Coming soon. Change its availability to `live` in `landingNewFeatures.ts` when they are set.
- Desktop app 0.26.0 must be released before the "Desktop app 0.26.0" cards are true.

**Owner check.** Open the landing page on a phone and a desktop after the chain is merged and 0.26.0 is out; confirm each card describes something that is live.

**Verified.** tsc, eslint, ui-lint clean; vitest `components/landing` 57 passed; e2e: new section test and `/` render plus accessibility checks pass at 360, 768, 1280, light and dark. Pictures: `.cache/round3-LP1-tools/shots`.

**Not verified.** The desktop crops predate the last review fixes of their slices (same code paths). `ReplayDemo.browser.test.tsx` fails here without the generated browser engine (built without `NEXT_PUBLIC_INSTANT_IMPORT`); it imports nothing changed. Full suites.

**Ledger.** None.
