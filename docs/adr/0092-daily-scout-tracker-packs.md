# ADR 0092 — Daily Scout Tracker packs

**Status** Accepted · 2026-11-13

**Builds on** [ADR 0083, SC2 Daily static packs](0083-sc2-daily-static-packs.md)

Daily Scout at `/arcade/scout` has five puzzles per UTC day and uses SC2 Daily’s immutable pack schedule, local progress and spoiler-free score format. Its schedule lives at `/daily/scout/v1/index.json`. Tracker and practice streaks use distinct storage from each other and from SC2 Daily. The Scout page fetches only same-origin static assets and makes no API, sign-in, vote, analytics or sprite requests.

Each puzzle contains a detector strategy, crop dimensions and an ordered list of allowed structures with appearance time in game seconds and the initial Tracker placement relative to the crop. We show placements cumulatively through 7:30. The timeline includes exact positions and lets players bring any numbered marker to the front. Unit paths, movement after placement, deaths, raw maps, absolute coordinates, player and replay identifiers, replay dates, custom build text and the source path are excluded. The immutable filename hashes only the sanitized public pack.

The allowlist is a subset of stable race and matchup detector labels with recognizable building clues. The builder uses the standard Python replay event extractors and strategy detectors with empty custom builds and released preset policy. It takes the label and initial Tracker positions directly from the same replay and player slot. Every published crop must retain the label's required placements and timing cues. Some detectors also use unit or upgrade evidence during classification. Each replay-content hash and player slot may appear once in a plan. The builder requires complete Tracker events, and neither StarCraft nor an engine observation recording is needed.

## Publish a Tracker set

1. Obtain five distinct human 1v1 openings with consent to publish the selected building evidence. Keep the replays and plan outside the repository. Use the Python environment from `apps/replay-engine` with its installed dependencies. To verify the side and strategy, run `python apps/replay-engine/scripts/scout_source.py --replay <local.SC2Replay> --perspective <exact-in-replay-name> --side <me-or-opp>` from the repository root. Review its detector label and initial building placements against the replay and use those placements to choose the crop. Keep that output private.
2. In the local plan, include one or more future UTC days. For each day include five sources. A single entry below illustrates the shape.

   ```json
   {
     "days": [{
       "day": "2027-01-01",
       "sources": [{
         "replay": "./private/opening.SC2Replay",
         "perspective": "ExactInReplayName",
         "consented": true,
         "side": "me",
         "crop": { "left": 10, "bottom": 20, "width": 100, "height": 80 }
       }]
     }]
   }
   ```

3. From `apps/web`, run `node scripts/build-daily-scout.mjs --plan <local-plan.json>` and pass `--python <interpreter>` if the replay-engine environment uses a different Python. Optional `--out <folder>` stages the output in another directory. Seed a new Scout output directory with `--practice` before using a plan. Review the sanitized packs and the index diff, then commit those public outputs and deploy before the scheduled UTC day. A published day cannot be changed after it starts.

Seven authored practice sets ship with an empty Tracker schedule. The live feed requires an owner to supply and review consented clips. The browser falls back to the labeled practice rotation on unscheduled days.
