# Game page benchmarks checkpoint

Branch: `codex/wave3-game-benchmarks` in the clean former Dashboard worktree
`C:\SC2TOOLS\.worktrees\wave4-agent-dashboard`. Its original Dashboard branch
and the merged Studio source branch are preserved. Initial base is current
main `9818dab971fab4ba10e6696274f5c2eec0051356` (Studio #702 included).

## Behavior

- Authenticated `GET /v1/games/:gameId/context` verifies the owned, non-resumed
  current row before every cache lookup. Foreign, absent, resumed and erased
  games remain 404. Its response is `private, no-store` and has no owner ids,
  replay ids/logs, check-in notes or opponent identities.
- Personal macro score, APM, spending quotient and duration use the latest 50
  strictly earlier ranked 1v1 games in the same concrete matchup. The indexed
  owner/date match precedes sort, limit 50 and Mongo's approximate percentile
  group. Missing measurements have individual n and null summaries; zero
  remains an actual measured zero. Canonical ladder classification is required;
  the existing safe two-player fallback handles old missing match-format flags.
- League context uses only the existing nightly cached table and percentile
  helper, never a new request-time corpus aggregation. Both the whole band and
  individual metrics require 50 samples. `lookup` now suppresses sparse metric
  deciles in the response itself, including the existing `/v1/benchmarks` route.
- Expansion medians follow the confirmed check-in's effective build first,
  including its private custom slug. Up to 25 earlier ranked matching-build
  games supply one natural start each. Starting townhalls at <=10s are skipped.
  Five usable timings are required. Only the owner's own projected buildLog is
  read, one detail at a time and reduced immediately; old inline logs retain a
  projected fallback. The unbounded built-in dossier method is not called.
- Cold work is bounded to four contexts per process with 503 + Retry when busy.
  Identical requests coalesce; at most 200 context summaries and 1,000 scalar
  natural timings are retained for five minutes. Overlapping neighboring-game
  samples reuse scalars, avoiding repeated R2 reads. No raw log is cached here.
- The web card sits under Mechanics and passes expansion medians to the real
  loss autopsy. Per-metric n, middle-half/median and cached league date are
  visible; duration is descriptive. Dot strips describe the opponent-league
  proxy. Tails read <10th / >90th, tied deciles use the tied interval midpoint,
  and league 404 keeps the personal comparison. A reusable account-scoped SWR
  hook dedupes league tables for 24h. Help slug: `benchmarks`.
- Independent review fixed cache invalidation when either replay race changes,
  and made fresh context league data authoritative over stale SWR tables/404s,
  including an explicit privacy-suppressed null. The existing date/_id index
  serves the deterministic sort without a blocking tie sort.

## Evidence before independent review/final integration

- API:64 assertions across real-Mongo context, league table and game-neighbor
  suites. Includes 50-game cap/order/isolation, exact privacy floor, sparse
  payload suppression, check-in-vs-detector timing cohorts, modern detail
  projection, 25-game cap/five-timing floor, cross-page scalar reuse, bounded
  concurrent work/coalescing/Retry, cache-after-erasure and unknown matchup.
- Web:59 focused benchmark/page/help assertions plus four independent page
  recovery assertions. The real page/autopsy test fires `late_expansion` and
  exposes its 3:40 seek with server-supplied medians. Full API/web types and
  strict changed-source lint passed. Help index regeneration is current.
- Production build and every unchanged bundle budget passed: landing 213.6/215,
  app 223.5/240, game 319.7/440, opponent 498.3/500 and Try 232.5/240 kB.
- `node apps/web/tests/manual/game-benchmarks.cjs` from the repo root (or
  `node tests/manual/game-benchmarks.cjs` in apps/web) reproduces 72 actual
  component/browser assertions at 320/390/768/1440, dark and light. It uses
  synthetic API/auth/help boundaries with production CSS, and blocks external
  requests. Zero overflow, browser errors or outbound requests. Keyboard Help
  and Retry, league 404/personal retention, missing measurement and real autopsy
  seeking pass. Screenshots in `docs/handoff/screenshots/game-benchmarks-*` were
  inspected at 390px dark and 1440px light; desktop autopsy does not stretch blank.

No new infrastructure/env var, AI request, raised budget, production operation,
account publication, installer signing, release, version change or tag.
