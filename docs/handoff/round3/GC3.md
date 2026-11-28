# GC3: clips without Twitch (OBS replay buffer)

**Shipped (agent 0.26.1).** An optional **Save an OBS replay-buffer clip** switch on the Streams page, under a new **After each game** heading, off by default. When a game you played ends with its result known, the agent saves OBS's running replay buffer, waits for the synced replay to name it, and files it in a `Highlights` folder inside the folder OBS wrote it to (for example `2026-11-28 21-05 PvZ Victory vs Barcode on Alcyone LE.mkv`). It reports the name to `POST /v1/agent/streaming/clip`, which lists it in Stream Dock, Clips as a **Clip** entry stamped with when the game ended.

**Decisions (ADR 0114; 0113 is taken by PR 1006).**
- Trigger is the live `match_ended` event with a decided result, once per game. No FC1 data, no chat spikes, nothing asked of OBS during play.
- One OBS client: `ReplayBufferSaver` extends `ObsConnection`. A stopped buffer is never started; the hint under the switch is amber and says what to press.
- A replay that syncs before the save finishes is kept and names the clip. A save OBS accepts but is slow to name reads "took too long", not "could not be reached". Polling is 20 s.
- The Dock reuses the clip-moment log; the overlay's clip flag ignores `clip-saved`, so file names never reach the stream.
- YouTube Data API v3 has no clip resource (read 2026-11-28).

**Review fixes (10 findings, all real).** Overlay leak, early-replay loss, filing-time stamp, slow-save message, stale hint after switch-off, "no clip was saved" wording on the check, duplicated status sentence, help and changelog folder wording, account-change test, amber warning and re-rendered pictures.

**Verification.** Agent 761 passed (stream, layout, theme, guardian, chapter, version tests). API jest 83 passed over 4 suites, `tsc` clean. Web `tsc` clean, eslint clean, vitest 554 passed (overlay widgets, dock, help). Mutations 10/10 killed (`.cache/round3-GC3-tools/mutation-01`). Pictures at 425 and 1120 px, scale 1.5, no horizontal scroll.

**Not verified.** Against a real OBS (SaveReplayBuffer, the file move while OBS may still hold it). The CI first-load number for `/dock/[token]` (no Dock UI added; only a label and colour class). Light theme. Full suites and Playwright (orchestrator).

**Follow-ups.** None open. Ledger: none. Blocked on: nothing.
