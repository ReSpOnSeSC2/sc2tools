# Auth return to context checkpoint

Roadmap: Wave 5 `auth-return-to-context`; ADR0052.

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
