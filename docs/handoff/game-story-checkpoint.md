# Game story and fight ledger

Implements `game-story-fight-ledger` from the final plan on `codex/wave3-game-story`. The calculation core and its regressions are paired with the lazy game-page consumer. Main through PR703 and reviewed playback PR705 head `b27058d5` are integrated. Merge after PR705; remote checks and merge are still required before calling this shipped.

## Behavior

The shared game page uses existing macro, build and casualty responses. Army value, workers and income contribute equal-weight relative lead observations; the strip follows elapsed time in at most 120 bins and leaves null observations and gaps over 30 seconds unknown. It is not a probability or a causal explanation. Paired observations, deterministic recap variants, 30-second swings, peak army lead, worker overtake, fight counts and measured supply blocks supply replay highlights.

Casualties within 10 seconds of the previous casualty form one fight. The ledger shows priced resources, measured supply and top units, with unknown outcomes for missing prices. An absent casualty ledger can use explicitly labeled army-value-drop estimates only where each side has fresh observations around that window. Unmeasured sides remain unmeasured. An explicit empty casualty ledger remains authoritative. The ledger uses a table in wide containers and cards in narrow ones.

Wins and draws replace the old Result filler. Wins retain their largest macro leak, including an honest whole-game note when there is no timestamp. Losses retain Why you lost by default and provide a neighboring Game story tab. Mechanics and the existing replay stay mounted; every highlight and fight Watch action uses the shared game clock. Empty stories give Mechanics the full row. The story calculation, price catalog and ledger load together in a lazy chunk, with independent retry after a chunk failure.

## Verification

- Integrated pure calculation and real game-page/UI/playback consumer tests: 72 passing assertions across eight suites, including irregular elapsed-time geometry, estimated-value coverage, empty draws, shared-clock seeks, default loss selection, keyboard tabs, playback host selection and chunk retry without remounting Mechanics.
- Full web TypeScript and strict changed-source ESLint passed. Help index generation is reproducible; all 77 Help assertions pass, including the updated `game-page#game-story` entry.
- Required-engine production build and every unchanged bundle budget pass after playback integration: landing 214.1/215 kB, game 313/440, opponent 490.4/500. The heavy story math, price catalog and ledger remain outside the eager page chunk. Existing repository lint warnings are unchanged.
- The local browser fixture passes 64 checks at 320/390/768/1440 in light and dark themes. It verifies default loss selection, responsive table/cards, unknown prices, replay seeking and focus, minimum 44-pixel controls, no horizontal overflow, wins/draws/empty stories and labeled estimates. Inspected overview and ledger screenshots show readable wrapping and the shared page layout.

The browser fixture runs actual story, page and replay components with committed fonts and production CSS, explicit synthetic auth/API/Next boundaries and blocked non-local requests. Reproduce from `apps/web` with `node tests/manual/game-story.cjs` after a production build. Screenshots are stored in `docs/handoff/screenshots/game-story-*.png`.

No new API endpoint, persistence, environment variable, infrastructure, AI feature, external account operation or production migration is required. No performance budget is raised.
