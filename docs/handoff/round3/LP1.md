# LP1: What's new on the landing page

**Shipped (stacked on #1000, RZ2).** A server-rendered "What's new" section sits directly above Humdingers on `/`: six cards in three groups (Randomizer, Stream tools, Live), each with an availability label, a picture of the real UI with sample data and a link to its own help section. The eyebrow reads "Latest releases" and the intro says the live directory is on its way.

**Cards and what each claims.**
- Randomizer: build and unit draws per race (live on merge); the desktop loading card draw (Desktop app 0.26.0).
- Stream tools: channel tags and category, Stream Guardian (both Desktop app 0.26.0); game chapters (Dock list live on merge, YouTube write marked coming soon).
- Live: the `/live` page, marked Coming soon.

**Decisions.**
- Honest labels, tested: Live card keeps "Coming soon", desktop cards keep "0.26.0", Guardian text matches its rule (OBS neither streaming nor recording).
- Web pictures (Randomizer, chapters, Live) have light and dark renders swapped by CSS on the root `data-theme`; desktop-app pictures are dark in both themes. Fresh 2x renders for tags and Guardian; the loading card is the full card.
- Frames reserve the file's aspect ratio; `sizes` per card size; the Randomizer picture fades at its cut edge. No client code: `/` stays 202 kB (budget 215).
- Headings use text-h3/text-h4. The last tile of a three-card group fills its tablet row (tested).
- Not done: the signed-in What's new feed (`whatsNew.json`) is unchanged; adding entries notifies every signed-in user, so it is the owner's call.

**Owner actions.** `YOUTUBE_CHAPTERS_ENABLED=true` (then drop the YouTube note); Twitch and Kick credentials for `/live` (then set its card to `live`); release Desktop app 0.26.0; decide whether to add a whatsNew.json entry.

**Verified.** tsc, eslint, ui-lint clean; vitest WhatsNewShowcase + LandingPageContent 22 passed; e2e section test passes at 360/768/1280; 10 of 10 mutations killed (`.cache/round3-LP1-tools/mut-lp1-01`). Renders: `.cache/round3-LP1-tools/shots` (after) and `shots-before`, 360/768/1280, light and dark; no overflow, links 44 px.

**Not verified.** Live and desktop surfaces on released builds; `ReplayDemo.browser.test.tsx` fails locally without the generated engine; full suites (orchestrator).

**Ledger.** None.
