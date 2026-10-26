# App and landing action styles checkpoint

2026-10-26. Source-only work on `codex/wave5-site-cta` in
`C:/SC2TOOLS/.worktrees/wave3-owner-neighbors`, based on reviewed Header source
`b140ee319a8775fb93c26dfe7527b7a5997ed4ac`. The delivered Mobile branch, old
runtime artifacts, screenshots and all caches are preserved. This is a later
consumer slice of `ui-primitives-and-dialogs`; it does not complete the whole
consumer migration or the broader roadmap.

The exact nine-path manifest was recorded before edits in
`.cache/site-cta-owned-paths.txt`; original hashes are preserved alongside it.

## Source changes and boundaries

- AppChrome's two visitor actions retain AuthContextLink, auth return context,
  current public destinations, loading behavior and the Sign in sm breakpoint.
  The existing shared secondary/primary sm recipe replaces its two local
  recipes. Their height becomes the shared compact36px, from the older32px.
  The separate mobile sign-in navigation entry is unchanged.
- Landing's local CtaLink/variant/size implementation is removed in favor of
  existing LinkButton. The same routes, icon labels, visitor/player branches
  and browser rollout gate remain. Large actions keep a48px minimum; the
  smaller support/browser actions use shared44px. Height can grow so long
  labels wrap within a phone's width. Only wrapping/minimum/vertical layout
  classes remain local; appearance and focus come from the shared recipe.
- Exactly three retired UI baseline entries are removed. No new allowance,
  dependency, shared primitive API, auth behavior, endpoint, provider action,
  persistent preference or budget is changed. The native anchor semantics
  remain, including the rollout-off replay hash link.

## Authored verification — not yet run

Existing real AppChrome and Landing tests retain their auth, destination and
rollout assertions. Added assertions cover semantic single anchors, exact
return URLs, decorative icons and every relevant landing destination. Phone
wrapping is a browser geometry contract, not a class-name unit assertion.

The existing appearance suite adds both-theme app CTA matrices at
320/390/640/1280 and landing matrices at320/390/768/1440. They assert real
production CSS/font geometry, rest/hover/native keyboard focus and full AA,
auth hrefs/Enter behavior, visitor/player action counts, rollout-off native
hash behavior and wrapping with no horizontal overflow. The new landing
fixture renders the actual LandingPageContent/LinkButton while replacing
non-CTA showcases, auth and rollout boundaries. It serves only same-origin
GET assets, rejects/counts writes, unknown and external requests, and exposes
no real API, account, provider or clipboard operation. Existing AppChrome's
strict More appearance fixture is reused without edits.

All tests, types, lint, engine/sample admission, production build/budget,
browser/AA and screenshot review for this new slice are **unrun**. Runtime is
serialized behind Settings A1. Independent source review found no production
blocker and identified a proof gap: horizontal bounds alone could miss
multiline vertical clipping or a48px action becoming44px. The authored matrix
now checks exact48/44 minimums, vertical scroll containment and real text Range
line/bounds at320/390. It also checks landing rest/hover/native focus paints.
AppChrome reuses a synthetic API hook, not real clientApi permissions; its new
receipt adds the actual build ID without changing the older More fixture.
Landing image reads are bounded to png/webp/svg files inside public, not an
exact filename allowlist. No runtime is claimed for these proof amendments.
The review also caught focus persisting on an app action across viewport
changes. Its rest-paint sample now first focuses the fixture's existing Page
action, retaining the later native Tab/Shift+Tab ring assertion.
No new screenshot or successful runtime result is claimed here.
