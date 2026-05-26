# Auto-Discover Builds

> User guide for the Auto-Discover panel on `/app → Builds`. For the API
> surface and the discovery algorithm, see
> `docs/custom-builds-spec.md` (Discovery engine) and
> `apps/api/src/services/autoClassify/` (cluster engine, naming
> heuristics, scope filter).

## What it does

Every replay you upload gets a `myBuild` tag. Most replays land in a
named build the agent already recognises, or in one of your saved
custom builds. **Replays that match neither fall into a catch-all
bucket** — shown as `Macro Transition (Unclassified)` /
`Unclassified - <Matchup>` in the analyzer, and invisible to the
per-build win-rate / opponent / phase analytics.

**Auto-Discover Builds** scans that catch-all bucket per matchup
(PvP, PvT, PvZ and the Terran / Zerg equivalents), finds groups of
replays whose openings closely match each other, auto-names each
group, and lets you promote it into a real custom build in one click.

Once promoted, those replays — and any future ones that fit the same
shape — show up under the new build name everywhere the analyzer
slices by build (Builds tab, MMR by build, opponent profile, etc.).

## Where you find it

`/app → Builds`. A collapsible **Auto-Discover Builds** panel sits
above the build grid. It opens by default; closing it remembers your
choice for the rest of the session via `sessionStorage`.

Inside the panel:

- **Perspective toggle** — `You` clusters on your own opening events;
  `Opponent` clusters on what your opponents did. Useful both ways:
  the "You" view surfaces openings you keep playing without a name;
  the "Opponent" view surfaces lookalike strategies the agent has
  no built-in label for, so you can scout them more aggressively next
  time you face them.
- **Scan now** — re-runs the discovery scan immediately. Otherwise
  the panel uses a 60s server-side cache keyed on your latest upload
  time, so a fresh game blows the cache without waiting for the TTL.
- **Per-candidate card** — proposed name (editable inline), matchup,
  game count, win rate, cohesion (how similar the clustered games
  are), and a rules preview showing the derived signature.
- **Create** — promotes one candidate into a real custom build.
- **Create all** — promotes every visible candidate in a single batch.
- **Dismiss** — hides a candidate locally (session only, not server-
  side). "Show dismissed" brings them back.

## Rules

1. **Minimum five games per group.** A group of four lookalikes is
   suggestive but not enough to warrant a build name; we wait until
   the pattern is real.
2. **Never re-tags a game an existing detector or custom build
   already claims.** Discovery scope is filtered through the same
   rule-match predicates `/reclassify` uses, BEFORE clustering. Named
   builds the agent stamped and rules you already wrote are
   untouched.
3. **Promotion is idempotent on `(userId, slug)`.** Discovery emits
   stable signature-derived slugs, so re-applying the same candidate
   updates the existing row in place. No duplicate builds.
4. **Most-specific build wins.** After promotion, the global reclassify
   pass re-stamps games under whichever saved build covers them most
   specifically. A newly-created auto build can never steal a game
   from a more-specific build you already had.
5. **Promoted builds are first-class custom builds.** They carry a
   `source: "auto-classify"` provenance tag for the UI to badge, but
   list / stats / publish paths never gate on it — you can rename,
   edit the rules, publish to the community, or delete them exactly
   like a hand-authored build.

## Empty state

Until five lookalike unclassified games accumulate in any matchup,
the panel shows "No new build patterns yet" and the API returns
`candidates: []`. A brand-new library is silent and error-free — no
spurious notifications, no false-positive cards.

## Turning the panel off

`Settings → Misc → Advanced → "Show Auto-Discover Builds panel"`.
Off hides the panel on `/app → Builds`; the underlying
`/v1/auto-classify/*` routes remain available so other surfaces
(scripts, the build dossier, future opponent-scouting widgets) can
still consume discovery candidates.

The toggle is per-user and persists across devices via the existing
`/v1/me/preferences/misc` bucket.

## Limitations and follow-ups

- **Cloud-only.** Discovery + promotion happen entirely in the cloud
  API. No agent / installer version bump is required; the desktop
  agent keeps emitting the same `Macro Transition (Unclassified)`
  label and the cloud handles the rest.
- **Not exposed in opponent scouting yet.** A future surface could
  use the "Opponent" perspective to warn the streamer pre-game that
  a recurring opponent has a discovered pattern with no name —
  intentionally out of scope for this rollout.
- **One-build-per-cluster.** A single cluster always becomes a
  single proposed build. If a matchup has two distinct discovered
  patterns, they show as two cards.
