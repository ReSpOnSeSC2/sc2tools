# LV2: raid finder in the Stream Dock

**Shipped.** Picking Stream ending in the Stream Dock opens a lazy "Raid a channel" panel over the cached LV1 live list (`LiveStreamsService.list()`, no second provider fetch). Order: channels at 20 viewers or fewer, then channels you raided or that raided you, then the rest; never your own. Start raid and Cancel raid each ask first; Twitch's answer shows in place and an accepted raid is "Queued", never "done". Kick channels are links only.

**Provider (ADR 0110).** Own Twitch connect for `channel:manage:raids` (purpose map in `twitchPurposes.js`), server gate `TWITCH_RAIDS_ENABLED` (off), the streamer's own switch (off), a receipt written before Twitch is called, no re-send of an unconfirmed raid. History (last 30, out and in) sits on `preferences.twitchRaids`; incoming raids arrive through an `afterInsert` hook on platform events.

**Review fixes.** Unconfirmed and refusal answers are 4xx (the error handler blanks 5xx messages). Cancel settles the raid the Dock showed, works after the switch or gate goes off, and is offered for an unconfirmed raid and for a raid Twitch holds that the Dock never recorded (409 already queued). The banner names Queued, Waiting for Twitch or Not confirmed. Window is 2 minutes (Twitch counts 90 s); a raid that went still counts as raided. Per-user busy and process-capacity answers are separate. Focus moves to Cancel raid after a confirmed action. 44 px targets hold on coarse pointers (restated after the Dock's 40 px rule; checked in the built CSS order). Blocker and degraded notes sit under the list so rows do not move; labelled Retry on a failed load; history has a chevron; the lazy placeholder reserves the panel's height. Complexity under 10 in the new code.

**Tests.** API 174 across the raid, connect (new: consent, scope, lease), policy and neighbouring suites; web 776 across dock, live, help, settings; tsc, eslint, ui-lint clean. Mutations 10/10 killed (`rec-mut1`, cache folder, 6 API and 4 web).

**Budget.** /dock/[token] first load: base 225.77 kB locally, branch 225.88 kB (+102 B for the loader, the lazy panel and a 52 B class string). Local reads about 1.0 kB above CI (CI was 224.8 of 225), so CI should read about 224.9. No budget changed.

**Not verified.** Live Twitch POST and DELETE helix/raids and the real OAuth popup (fakes only). Settings page not opened in a browser. Pictures are the component in jsdom with the built CSS at 360 and 1280, light and dark, not inside the full Dock page; fonts differ. The ADR keeps name matching: the stored platform event has no id field.

**Follow-ups.** Match history by Twitch user id (needs an id on the stored event). Owner: set `TWITCH_RAIDS_ENABLED=true`, approve Connect raids, start one raid and cancel one on a live channel.

**Ledger.** No roadmap ledger item. Blocked on nothing.
