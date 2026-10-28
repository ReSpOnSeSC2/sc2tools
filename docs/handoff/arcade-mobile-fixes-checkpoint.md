# Arcade mobile text and round selection — 2026-10-27

Two owner-reported defects are repaired on `codex/bingo-mobile-fit` from
main900ac8dc. Delivery is pending the release evidence below.

Bingo uses intrinsic equal-height rows and wraps long unit names inside each
of its five columns. Full objectives, predicates, scoring and saved cards are
unchanged. Semantic row wrappers preserve the grid accessibility hierarchy.
Opponent Bracket Pick derives its selected option from the runner's current
answer; a previous round's local selection can no longer color a new question.

Validation:39 focused unit tests pass, including three real runner rounds with
repeated opponents/answer positions and an identical repeated question. Six
single-worker browser cases cover76 real objective labels in64 card/size/theme
specimens at320/390/768/1280px and100/200% text. Sixteen AA scans have no
serious/critical violations; no unexpected requests, page errors or synthetic
store mutations occurred. Root visually inspected390light and1280dark captures.
Browser data/auth are explicit synthetic boundaries, not production acceptance.
Initial fixture selector/subscription failures are retained in
`.cache/arcade-fixes-verification-20261027/browser-01` through`browser-03`;
per-card document mounts now model independent saved cards with unchanged
coverage/containment assertions. The original failure evidence was not removed.
Whole web types passed before the new bracket test; final build/types/CI follow.
Existing Bingo effect dependency warning is unchanged; do not claim zero
inherited warnings. Help and changelog cover both fixes.

Engine admission verified40 canonical sources, seven retained assets and the
four-game sample without generation/download/pruning. Production build and
all83 unchanged caps remain required. No native agent changes/release.

The197-item program remains active and incomplete. Dashboard cache status is a
separate slice, with USER_CACHE_ENABLED kept off; maintained gameStats/lighter
/me, dependency-safe cache expansion, revocation-coherent auth reuse and the
corpus delta/IndexedDB/history contracts remain outstanding.

Final local release gates: production build succeeds, including whole-web types; all83 original caps pass. Postbuild engine admission remains identical. Scoped lint has zero errors and only the unchanged Bingo effect warning. Help97 regeneration is deterministic; UI baseline has1763files/639existing occurrences with no new or stale allowances. Remote CI, merge and live acceptance are still pending.

Release update:PR797 passed all exact-head checks at0e88349e and squash-merged asc100529d394e0a12fa3c95676cf6eef763dc1d07. Authenticated Vercel UI confirms Ready production8Aun1CWuJJCrzY5KJdR3jTxKLNke for that source and sc2tools.com. A dedicated fresh signed-in document explicitly measured390px:25cells/five rows, zero escaping labels, no horizontal overflow and saved16/25 retained, without reroll. The earlier after measurement's viewport qualification was invalid (desktop1920px); that evidence is retained and superseded by production-acceptance-02.json. Bracket initial choices are unselected; a live answer/Next-round check awaits explicit choice after automatic review blocked attempt/XP submission. Local repeated-round regression passes.
