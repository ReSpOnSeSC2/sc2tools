# Private quick-search interface checkpoint

Local verification completed on 2026-10-27. The API was released first in
PR #794 and verified Live on Render at
`dcb1f8368437a34fa2e8177ab5bc65001d1551cc`. The independent Strategies
preference fix is live from PR #795.

## Behavior and boundaries

Search now includes the signed-in owner's opponent names and saved build
titles. Private groups retain the API's order and show at most eight results
each, with links to the complete libraries. Map quick search remains deferred;
Open Maps remains available. Public guides keep their existing behavior.

Private queries travel only in the authenticated POST body. They are not
saved in URLs, recent searches, browser storage or analytics. Fixed-path
feedback sanitization removes every private-search query parameter, including
unsupported GET requests. Explicitly submitted support reports retain the
existing page-path policy; analytics collapses private record destinations.

The strict version-2 decoder bounds the actual response stream before JSON
decoding. Owner, route, opening and query changes retire requests and retained
actions. A valid selection transfers a bounded typed target into the existing
Settings unsaved-edit guard; stale confirmations cannot navigate later.

The compiled activation policy loads through the existing fixed Search
runtime import. Authority and retirement checks remain eager. No server
response or caller can register its own navigation policy.

## Verification

- 281 integrated tests across 15 files passed after the policy split.
- All 23 feedback cases passed after four equivalent sanitizer reductions.
- All 41 app-shell route cases pass with the Next navigation boundary's
  required search-parameters export. Existing assertions are unchanged.
- All 37 streaming-token and related Settings guard cases pass. The dirty
  fixture awaits real state publication and completed rename/refresh while
  retaining every original lockout and body-preservation assertion.
- Final whole-web TypeScript and strict lint of all 30 changed web files pass.
- Production build `PJe4s15VV3tjLeDyFTb9q` passes all 83 original route caps:
  `/app` is 239.8/240 kB and `/community` is 190.0/190 kB.
- Forty canonical engine inputs, seven active assets and the four-game sample
  remain verified. No asset generation, downloads, pruning or cap changes.
- Six browser consumer documents cover phone/light and desktop/dark ready,
  failure, Retry, native streaming abort/decline and real Settings handoff.
  All imported web product inputs match the successful build's raw snapshot.
- Twelve unchanged public-search cases also pass against the actual compiled
  Next artifact across phone, tablet and desktop. The artifact boundary
  explicitly reconstructs the sole final-LF source difference; this is not a
  claim of a rebuilt exact-current-head artifact or private authentication.
- Ten accessibility reports contain zero violations. Independent contrast has
  zero failures or unmeasured labels. Three raw phone contrast incompletes for
  status text are preserved; manual review found no visible overlap, with
  measured 9.24:1 text contrast against the 4.5:1 requirement.
- Eight captures were reviewed. Four synthetic captures are committed in
  `validation/private-search-ui/`; they do not contain production user data.
- Every test/build/browser group has a completed ownership check. The browser
  fixture positively unmounted all six consumers and closed their pages and
  contexts, with zero remaining sockets, timers, held bodies or listeners.

Browser fixtures use explicit auth, router and API adapters. They do not
claim actual authenticated Next or production search acceptance. Exact-head
CI, merge and live authenticated interface acceptance are release gates in
the interface PR.

## Rollout and rollback

No new infrastructure, environment variables, provider settings or desktop
agent release is required. The API's single additive optional opponent index
is documented in `private-search-api-checkpoint.md`; no game index is added.
Retire the interface before rolling back API functionality, retaining the
fixed-path privacy protections for cached clients. Do not automatically drop
the additive index. Map quick-search publication remains separate work.
