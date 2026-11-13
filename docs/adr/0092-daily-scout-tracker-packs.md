# ADR 0092 — Daily Scout Tracker packs

**Status** Accepted · 2026-11-13

**Builds on** [ADR 0083, SC2 Daily static packs](0083-sc2-daily-static-packs.md)

Daily Scout at `/arcade/scout` has five puzzles per UTC day and uses SC2 Daily’s immutable pack schedule, local progress and spoiler-free score format. Its schedule lives at `/daily/scout/v1/index.json`. Tracker and practice streaks use distinct storage from each other and from SC2 Daily. The Scout page fetches only same-origin static assets and makes no API, sign-in, vote, analytics or sprite requests.

Each puzzle contains a detector strategy, crop dimensions and an ordered list of allowed structures with appearance time in game seconds and the initial Tracker placement relative to the crop. We show placements cumulatively. Owner-selected crops can include proxy structures. The map uses numbered dots and a corresponding accessible timeline. Unit paths, movement after placement, deaths, raw maps, absolute coordinates, player and replay identifiers, replay dates, custom build text and the source path are excluded. The immutable filename hashes only the sanitized public pack.

The allowlist is a subset of stable race and matchup detector labels with recognizable building clues. The publishing script checks it against the detectors’ literal returns, and both the builder and browser validate their respective data shapes. The builder requires the operator to attest to consent and detector-label provenance. It accepts complete Tracker playback only and never runs StarCraft or needs an engine observation recording.

## Publish a Tracker set

1. Obtain five distinct replay openings with consent to publish the selected building evidence. For an owned replay with Tracker playback, open its map replay and save the authenticated `GET /v1/games/:gameId/map-playback` response from the browser’s Network panel to a local JSON file. Confirm which side produced the race detector label, check that the clue crop covers the decisive placements, and review the answers against the replay. Keep original replays, source JSON and the plan outside the repository.
2. In the local plan, include one or more future UTC days. For each day include five sources. A single entry below illustrates the shape.

   ```json
   {
     "days": [{
       "day": "2027-01-01",
       "sources": [{
         "file": "./private/clip.json",
         "consented": true,
         "labelSource": "detector",
         "strategy": "Terran - Proxy Rax",
         "side": "me",
         "crop": { "left": 10, "bottom": 20, "width": 100, "height": 80 }
       }]
     }]
   }
   ```

3. From `apps/web`, run `node scripts/build-daily-scout.mjs --plan <local-plan.json>`. Optional `--out <folder>` stages the output in another directory. Seed a new output directory with `--practice` before using a plan. Review the sanitized packs and the index diff, then commit those public outputs and deploy before the scheduled UTC day. A published day cannot be changed after it starts.

Seven authored practice sets ship with an empty Tracker schedule. The live feed requires an owner to supply and review consented clips. The browser falls back to the labeled practice rotation on unscheduled days.
