# Auth return to context checkpoint

Roadmap: Wave 5 `auth-return-to-context`; ADR0052.

## Public-player main integration

Merged current Public main `251cb319` normally at `96a8ab57`, without source
conflicts. The Auth delta contains no API changes. All 104 checks in seven
return-policy, continuation, retained-action and author-capability suites pass;
Help regenerates its 89 articles without a semantic registry change.
Whole web types, all 19 UI rules and the combined 1,671-source scan pass
(656 inherited occurrences, no new/stale allowance).

The old local build had a generated checker for the moved Community page.
Next's supported `typegen` refreshed its current validator; its one obsolete
per-page checker was retained in a full 120-file cache snapshot, hash-verified,
then retired from generated output. No source route or type gate was changed.
Logs are root `.cache/auth-return-public-integration-*`; the snapshot remains
in `.cache/auth-return-before-public-typegen`. Current-head remote CI will
validate the integrated production and responsive build. Earlier local browser
and production proof below remains scoped to its recorded source boundary.

## Shared chart main integration

Merged chart main `56e725ae` normally at `e5fc04da` without an Auth source
conflict. Whole web types, all 19 UI-rule tests and the 1,656-source scan pass
(677 inherited occurrences, no new/stale allowance). Logs are root
`.cache/auth-return-chart-integration-*`. Auth runtime and its tested action
lifetimes are unchanged; the local production/browser proof below precedes this
independent chart integration. Exact-head CI must validate the combined build.

## Final current-main local proof

Final checked HEAD is `4aa73f14dd4ce1056d3deca789c494fca3a46883`, including
current main #759. No Auth runtime edits occurred after the preserved integration
repair. The earlier 244-check/18-suite consumer pack and strict seven-file lint
remain applicable; they were not repeated without a new source concern.

- Whole web types pass before and after Next refreshes generated route types.
  All 19 UI-rule regressions and the combined 1,653-source scan pass, with 748
  inherited occurrences and no new or stale allowance. Main independently
  retired seven occurrences since the 755-occurrence repair proof below.
- One direct Next production build passes compilation, types, 144 static pages
  and tracing. Dummy Clerk keys, local-only API and CI feature flags were used.
  Retained validated engine 1.6.12/fc21ebe5bf52a53c assets were preserved; no
  engine compilation/copy, dependency installation or deployment ran. No engine
  parse or new production-engine validation is part of this Auth proof.
- All unchanged budgets pass: 18 named routes plus 62 default-budget routes.
  Examples: Community 188.3/190, Guides 172.6/175, Today 233.7/240, Try 213.7/240
  and Welcome 174.1/245 kB. No budget was raised.
- The build ran before `apps/web/tests/manual/auth-return.cjs`, so the manual
  fixture uses newly generated production CSS and actual local Hanken/Bricolage
  fonts. It mounts actual return-policy/forms/chrome/Welcome/action consumers;
  Clerk, navigation, sockets and import bodies remain explicit synthetic
  boundaries. This does not create or authenticate a real account.
- Pinned Chromium 1228 passes 145 checks across eight sequential contexts at
  320/390/768/1440px in both themes, with 16 new captures, 24 authenticated
  synthetic loopback writes and zero unexpected requests. External requests are
  recorded and aborted. Save, two-copy vote parity, Ghost assignment/navigation,
  forced/cross-form destinations, Welcome continuation, rejected external return,
  resolved theme, overflow and page-error assertions all pass.
- `AUTH_SHOTS_DIR` points to the new absolute directory
  `C:\SC2TOOLS\.worktrees\wave4-agent-dashboard\.cache\auth-return-final-shots`.
  All 16 original committed PNG SHA256 values exactly match the pre-run inventory
  `.cache/auth-return-final-original-sha256.json`. Originals were not overwritten.
  Phone Light 320px vote, Dark 390px vote, Dark 1440px Welcome and Light 768px Welcome
  captures were visually inspected without an observed layout/theme defect.
  Root independently reviewed the Light 320px vote and Dark 1440px Welcome,
  then copied them unchanged with matching SHA256 to new review paths
  `docs/handoff/screenshots/auth-return-current-vote-light-320.png` and
  `docs/handoff/screenshots/auth-return-current-welcome-dark-1440.png`.
- The browser and loopback server close successfully; no listener on port 3261 remains.
  All runtime jobs are closed. Only this checkpoint changes existing source;
  root owns the two new synthetic review PNGs. The original 16 stay intact.
  Cache/generated fixture artifacts and the two pre-existing temporary scripts
  are retained. Neither obsolete temporary script was executed.

Final logs are in root `.cache/auth-return-final-` with suffixes
`ratchet-rules.log`, `ratchet-scan.log`, `types.log`, `build.log`, `budgets.log`,
`post-build-types.log` and `manual.log`. New screenshot review paths are
`.cache/auth-return-final-shots/auth-return-vote-light-320.png` and
`auth-return-welcome-dark-1440.png` in the same directory. No Git mutation,
provider operation or production preference/account write was performed by the
validation workers. Root owns preservation, remote CI and delivery.

## Current main integration repair

2026-10-25. Current local base `849f2cdb` merges the preserved `d0c58f5e`
auth source with actual shared-UI/release main. This section records the new
integration work; verification numbers below belong to earlier frozen heads.
Focused checks below pass for these repairs. Final local production/browser
proof is recorded above; remote gates and delivery remain root-owned.

- Community action callables now retain their issuing render identity. Saved
  callbacks cannot admit an operation after owner/record changes, ABA or
  unmount, even when the operation has no token lookup of its own. Six new
  focused cases cover those boundaries and a stale callback competing with
  the current busy slot. Existing in-flight JWT/body/deadline fences remain.
- Automatic chrome integration retains Header/AppChrome Appearance dialogs,
  Light/Dark/System choices, MobileNav's stable close reference and visible
  focus filtering. The merged unit mocks already preserve compound Clerk
  menu components together with auth-return search-parameter hooks.
- The manual auth fixture now models Clerk's compound menu, uses the current
  theme storage key and explicit mode, and asserts the mounted page's actual
  resolved palette and CSS background token. Its default captures go to local
  cache, with `AUTH_SHOTS_DIR` still supported. The original sixteen committed
  images are preserved; their SHA256 snapshot is a local review artifact.
  All writes stay synthetic on loopback, external attempts are recorded and
  blocked, and cleanup also closes the server if browser launch fails.
- UI lint recognizes AuthContextLink as an anchor, including canonical-module
  aliases and namespace imports. Exactly seven existing CTA allowances change
  signatures: six chrome auth wrappers and Save's existing sign-up anchor's
  new intent callback. File, rule and occurrence counts are unchanged. No
  allowance, file waiver or rule exception is added. The scoped migration
  audit is `apps/web/.cache/auth-return-baseline-migrations.json`.
- Running only the existing canonical `gen-build-variant-ids.mjs` generator
  yields 198 IDs, including `pvt-dt-rush`, and no semantic generated-file delta.
  Exact catalog-ID admission remains narrow. The canonical player/archive
  return-path test is additive; no allowlist expansion or consent bypass.

Verification: 244 checks pass across 18 directly affected suites, covering the
six new retained-callback cases plus Community/resume/Practice/Welcome/auth
forms/links/chrome/ThemeChoice and exact definition-ID parity. Full web types,
strict lint of all seven owned code files, 19 UI-rule regressions and the full
1,653-source ratchet scan pass. Semantic debt remains 755 occurrences, with no
new or stale allowance. Current logs are root `.cache/auth-return-repair-*`.

All jobs are closed and the serialized slot is released. The fresh actual local
auth matrix with cache-only captures and final production build/unchanged
budgets now pass as recorded above. Original 16 screenshot hashes remain unchanged.
Neither obsolete opponent-order nor air temporary script is used. No dossier
order change is part of this repair.

The web implementation centralizes safe return paths and both Clerk forms'
forced/cross-form destinations. Header/mobile/app navigation, Community,
Guides and Reviews preserve allowed public context. Welcome displays the
continuation and returns there from Skip/Done. Public Save, vote and Ghost
Practice actions queue one path-bound fifteen-minute session intent and run
their original action after auth. StrictMode, duplicate responsive instances,
held JWT/body work, account ABA changes and timeouts are fenced. Practice
opens the existing Ghost settings anchor with a toast. Help explains expiry
and retry. No production account/provider operation has been performed.

Preserved source: auth foundation `2d5aa330`, final Ghost `104e810d`, actual
Moments squash `b2212bbd` and owner main `ecfb0491` integrated. The independent arm review's competing responsive copy finding
was corrected by shared in-flight admission and a held-save test. Shared,
payload-matched failures make a hidden claimant's error visible in the other
copy; manual retry clears it. A delayed account read no longer overrides an
explicit URL-selected setup step. Independent final continuation review is clear.

Local verification so far:

- Full frozen web suite: **7,666 tests across 838 suites pass**, with one
  expected skipped suite/test. Includes the original Try claim contract.
- Final practice/shared-resume/Community sweep: 54 tests in eight suites pass.
- Full web types and strict scoped lint pass on the final shared-outcome source.
- Combined Ghost/Moments API: **88 tests in five suites pass**; full API types
  pass. Integrated source includes both independently reviewed feature paths.
- Native upload gate/queue: **76 tests pass**, including the owner's new
  overflow cases and the isolated clock/event-barrier CI correction.
- Required engine prebuild/smoke: `f96c086eb83fdc40`, 223 files/79 compiled
  modules, 1.19 MiB.
- Production Next build and all unchanged budgets pass: landing214.7/215,
  Today238.8/240, Community184/190, Guides169.3/175, Dock214.6/225,
  overlay235.9/240, widget318.8/325, Try233.4/240, Welcome171.9/245 kB.

The actual Chromium matrix passes 145 checks across eight contexts at
320/390/768/1440 px in both themes, with 16 captures and 24 synthetic local
writes. It covers real Header/MobileNav context, both auth forms' force
destinations, sign-up through welcome/Skip to one Save, two-copy vote parity,
one Ghost assignment/toast/settings navigation, rejected external redirects,
Done continuation, overflow and page errors. API/auth/Next/socket/import body
boundaries are explicit and all external requests are blocked. Root inspected
the phone vote and phone/desktop welcome captures. Final frozen build/full-suite
pass. Exact-head remote gates remain required before merging. The PR depends on
Ghost734; retarget to main after that feature lands and check the actual merge
tree before merge. No infrastructure, release, version or integration activation
is part of this work.

## Final main and fixture compatibility

Current main's owner-written native upload barrier is retained exactly; its
nine gate tests pass. The own-build Ghost controls retain the explicit auth
resume behavior when merged with the released practice feature.

Responsive fixture navigation modules now export reactive pathname and search
hooks, matching the production auth-context link contract. The publishing
smoke expectation uses the public `/community?publish=1` continuation. Actual
responsive verification passes 46 checks with two expected skips across all
three configured viewports.

The Unified Editor's reviewed, recoverable lazy modal boundary is reused for
the existing landing/replay entry points. This leaves room for an exact known
catalog-ID allowlist for `/definitions?variant=...`, with no private `/builds`
continuation. The shared helper, generated 197 IDs and parity test match PR738.
Unknown IDs, additional/duplicate parameters and nested paths are rejected.
This public continuation is shared with PR738's explicit Definitions action;
the auth helper introduces no hidden navigation or creation.

These additions pass 104 affected web consumer assertions, full web types and
strict new-source lint. The integrated production build passes every unchanged
budget: landing 189.6/215, Today 238.2/240 and widget 318.8/325 kB.

The final source also integrates main `c7b9446f` (Series and Chat) and the
requested seven-minute air opening correction from PR740, including both
generated API catalogs. The required engine is `25b300818c31d41b`; no old
engine build is used. The final actual Chromium auth matrix again passes
145 checks / eight contexts / 16 unchanged captures, with 24 synthetic writes,
no unexpected requests and no external traffic. Every final production budget
passes after this integration. Final-head remote checks remain the merge gate.

## Final shared request integration

Current main's Twitch changes and the exact shared query/editor ownership fix
are integrated through `de9f98e9` and `1b56cbf6`. The actual root-StrictMode
Community Save/vote consumers exposed a deduped initial-read cancellation;
the shared correction retains only a synchronously reactivated same-owner
scope while real account/unmount capabilities remain immediately invalid.
All 169 final auth/private-query consumers pass across 12 suites, including
the three reproduced return-action cases. Full types and final production
build pass. Every unchanged budget passes: landing 190/215, Today 238.7/240,
Dossier 448.1/500 and Welcome 173.9/245 kB.

The actual browser matrix passes 145 checks/eight contexts/24 synthetic writes,
with no unexpected or external traffic. `AUTH_SHOTS_DIR` directs rerun captures
into local cache so the 16 reviewed committed images remain intact. Independent
integration/source review is clear. Final exact-head CI, Vercel and current-main
merge-tree checks remain required; no provider or production write occurred.
