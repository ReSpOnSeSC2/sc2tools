# 0083. Publish SC2 Daily as static clip packs

Status: Accepted

/arcade serves five field fights for a UTC day from versioned static files. The tiny index revalidates and points to immutable packs of allow-listed clip data and cropped terrain. Each published clip contains ten seconds of relative time and crop-local coordinates, plus neutral teams, unit types and priced losses. The index contains scheduled publication days and hashes of the published bytes. It carries no source recording keys or dates.

The offline builder reads complete Recorded Agent playback. It uses the first observed local attack after a quiet period and requires both armies in the opening frame. It excludes structure losses, worker-heavy trades, fights spread across the map and outcomes close to a scoring boundary. It prices losses with the replay viewer's patch costs, excluding units consumed in morphs. A fight needs a complete ten-second window within a verified source segment. The crop and sample rules favor clear field fights that fit on phones.

The clip player uses the replay renderer with local icons and a fixed view. Accessible opening rosters describe the armies before the guess. Resource losses appear in the interface after the guess. Static pack bytes contain answers and are inspectable.

The live schedule requires owner-provided, consented recordings (G6). A generated seven-day practice set rotates while a day's recorded set is unavailable. The browser stores separate recorded and practice streaks locally.

## Build a schedule

Run from apps/web with its existing dependencies installed. The repository fixture week is reproducible with:

    node scripts/build-daily-packs.mjs --practice

For recorded sets, keep the plan, source manifests, sibling playback segments and matching layout images outside public/ and version control. Each manifest is the desktop Agent's complete manifest-<digest>.json. Supply the full playable-area layout as an ordinary image with no annotations or embedded player information. The patch era uses the existing before/after model.

Example plan:

    {
      "days": [{
        "day": "2026-12-01",
        "sources": [
          { "manifest": "recordings/manifest-<digest>.json", "layout": "layouts/map.png", "era": "after" }
        ]
      }]
    }

    node scripts/build-daily-packs.mjs --plan /path/to/private-plan.json

Source paths are relative to the plan. Add recordings until each day yields five qualifying fights. The command publishes the index only after all requested days build and preserves the other scheduled days. Review the five opening frames, outcomes and terrain crops for every day before publishing. Commit only reviewed output under public/daily/v1/. Keep the release horizon short.
