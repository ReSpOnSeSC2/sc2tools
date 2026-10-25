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

Preserved source: auth foundation `2d5aa330`; final Ghost `9a00f61f` and owner
main integrated. The independent arm review's competing responsive copy finding
was corrected by shared in-flight admission and a held-save test. Shared,
payload-matched failures make a hidden claimant's error visible in the other
copy; manual retry clears it. A delayed account read no longer overrides an
explicit URL-selected setup step. Independent final continuation review is clear.

Local verification so far:

- Initial helper, existing Try and pending action suites: 102 assertions.
- Auth/navigation/Community/Guides/Reviews consumer sweep: 367 initially pass;
  the eight old fixture expectations were corrected and all 64 tests in those
  three files then pass.
- Final practice/shared-resume/Community sweep: 54 tests in eight suites pass.
- Full web types and strict scoped lint pass on the final shared-outcome source.
- A discovery run passed 7,623 web tests; it exposed fourteen old public-auth,
  router-mock and Help-date expectations. Those were corrected and the affected
  73 tests pass. Source refinements overlapped that discovery run, causing six
  practice failures from mixed cached module versions; a separate fresh final
  action sweep passes. A fully frozen full-suite run remains required.
- Required engine prebuild/smoke: `f96c086eb83fdc40`, 223 files/79 compiled
  modules, 1.19 MiB.
- Production Next build and all unchanged budgets pass: landing214.7/215,
  Today238.8/240, Community184/190, Guides169.3/175, Dock214.6/225,
  overlay235.9/240, widget316.6/325, Try233.4/240, Welcome172/245 kB.

The actual Chromium matrix passes 145 checks across eight contexts at
320/390/768/1440 px in both themes, with 16 captures and 24 synthetic local
writes. It covers real Header/MobileNav context, both auth forms' force
destinations, sign-up through welcome/Skip to one Save, two-copy vote parity,
one Ghost assignment/toast/settings navigation, rejected external redirects,
Done continuation, overflow and page errors. API/auth/Next/socket/import body
boundaries are explicit and all external requests are blocked. Root inspected
the phone vote and phone/desktop welcome captures. Final frozen build/full-suite
and remote gates remain required before merging.
