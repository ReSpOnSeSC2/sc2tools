# Reference build orders checkpoint

2026-10-25. Branch `codex/wave4-reference-build-order`, preserved in
`.worktrees/wave3-coaching-forms`. ADR 0058. Depends on unified editor PR 738;
do not merge ahead of that foundation. Current integrated source is `2cf48109`,
preserving Reference source `601d99dc`, with
the independently reviewed generic request fence in `c3faa6f9` and its complete
saved-editor test auth fixture in `a10b7d2a`. It integrates reviewed generic
hotfix/current-main dependency `a8fc536f` and frozen PR743 `de9f98e9` plus
StrictMode follow-up `1b56cbf6`, retaining the richer token gates and the
additional create-only/signature identity fields and tests.

## Implemented

- Optional version-1 reference data, at most 120 bounded steps, validated and
  projected before persistence. Untimed supply rows retain `t:null`; supplied
  0:00 remains distinct. Unknown actions are reference text, never match rules.
- Full owner detail retains private provenance. Community publication/detail
  include shareable steps and instructions but omit nested source replay IDs.
  Library/classifier reads omit the full order; a slim capability flag allows
  one bounded detail read only after an explicit card Practice action.
- The rich editor has Match rules and Build order tabs. Reference editing has
  clocks, supply, action picker, shareable notes, insert/delete, drag and keyboard
  row moves, five-minute trim, adjacent repeated-army compaction and explicit
  source-game fill. Game-created drafts auto-fill, folding worker rows into
  recorded supply without inventing samples.
- Upgrade practice keeps recorded completion clocks. If completion is absent,
  the reference clock stays unknown. Recorded start clocks and start supply
  stay in a shareable step note, rather than presenting start supply as exact
  completion supply. Manual/pasted upgrade clocks are explicitly completion
  checkpoints. Malformed/oversized legacy event rows cannot crash source fill.
- Deterministic paste accepts bracketed/plain clocks, Spawning Tool columns and
  Liquipedia supply-only lines. Per-line errors forbid partial import; unknown
  action/timing warnings remain saveable. The first-run pasted card is enabled.
- Private/public build details render reference plans. Community copies keep
  the public reference. Text, Markdown and .txt export preserve authored order,
  missing clocks, approximation and notes. Print caps and counts use the chosen
  reference, including mixed legacy/reference inputs.
- Practice prefers supplied timed known actions for the selected race. Unknown
  or untimed rows remain in the plan; approximate supply is omitted from exact
  HUD supply. Existing saved-reference/guide/replay/rule fallbacks remain.
- The shared editor hook now fences save, preview and inspection to owner,
  loading state, open/source/draft identity and operation epochs. Its deadline
  covers token lookup, headers, body and publication repair. Owner/source ABA,
  close, unmount and expired requests cannot dispatch or complete stale work.

## Verification

- 706 affected web consumers/helpers/Help and shared-query/review checks pass
  after the final PR743 integration. Fifteen editor real-transport
  scope regressions cover held JWT, headers, response body, publication repair,
  preview/inspect, owner/loading/source/signature/create-only/close/unmount and
  ABA boundaries.
- 26 focused API schema, private/public boundary and prior payload-bound checks
  pass with disposable MongoDB. Real owner save and publication retain steps
  while private replay IDs never enter the public document.
- Web/API types and scoped changed-source lint pass. Existing large API service
  files retain their pre-existing long-function warnings; no warning budget was
  increased. Help generation is reproducible at 88 articles.
- Required browser engine build/smoke passes `25b300818c31d41b` (223 files,
  79 pyc, 142939-byte fixture parse, Python 3.14.2), after integrating the exact
  reviewed seven-minute cutoff source `3dceab1c`. Its actual main squash
  `e2fa5d08` produces an identical merged tree; no source rebuild is needed for
  that ancestry-only reconciliation.
- Final production Next build and every unchanged performance budget pass:
  landing 190.1/215, Today 238.8/240, Builds 199.9/270, game 311.1/440,
  opponent 448.2/500, Dock 215.7/225, widget 323.8/325, overlay 239.7/240 kB gzip.
  This was a Next-only rebuild; the unchanged 25b engine was not rebuilt.
- Actual-source Chromium: 395 checks, 44 captures, five widths
  (300/320/390/768/1440), light/dark, production CSS/fonts, full-modal axe,
  overflow, keyboard editing, unknown/malformed paste, source worker folding,
  clipboard fallback, .txt download, recorded upgrade completion versus start
  supply, and held JWT/body owner switches.
  All 42 API requests and 11 writes are synthetic loopback fixture data;
  external browser traffic is blocked and unexpected API requests are zero.
  The final PR743 integration rerun passed all 395 checks against current
  production CSS, preserving the 44 existing captures because no UI classes
  changed.

Manual entry points are `apps/web/tests/manual/reference-build-order*.cjs`.
Captures are `docs/handoff/screenshots/reference-build-order-*.png`.
Representative 300px paste/export, 320px editor, focused tab/control views,
1440px dark source fill and 320/1440px upgrade completion views were visually
inspected; no layout blocker found.

## Remaining gates

Generic request ownership PR743 merged at `bef4054c`. Reference reconciled its
actual squash at `3d5e0a05`; tree `e87aa051c2a147bc8f92ebf4924064a636ef2113`
exactly matches the tested dependency tree. Final PR738 parent `fe5726ea` was
then integrated at `bf799d13`; only its evidence/harness bookkeeping changed.
No Reference product source or upgrade evidence changed after final checks.

The Reference draft PR is stacked on `codex/wave4-unified-build-editor` for an
additive review. It requires PR738 to merge, then retargeting to main before
its own coordinated green merge. Final CI, independent final visual review
and coordinated merge remain outstanding. Preserve both branches without
rebasing. Deployment quota failures remain held without redeploy retries.
No infrastructure, migration, integration activation, provider call, account
operation, version bump, release or production write is part of this pack.
