# Admin Users directory checkpoint

Pack: W3 admin-polish-8. ADR0047. Branch codex/wave3-admin-users.

Implemented the full Users list/detail specification: matched totals and stable
page/limit sorts, three additional filters, signed-up/Admin columns, semantic
relative dates, private streamed matching CSV with shared safe cell escaping,
10,000 cap and bounded admission/audit metadata. Removed storageEstimateBytes.
Detail adds decided win rate, sign-in/first replay/signup, guarded ID copy/manual
selection, linked lightweight recent games/opponents and ten scoped events.
Existing Support snapshot gains platform/last-seen and retains audit/imports.
Notifications retains userId in URL state and disables global mark-read while
scoped. Anonymized rows stay excluded from scoped activity and are never
rehydrated. No production export/index/migration execution took place.

Literal user totals use countDocuments. Derived device/game filters count the
same matched aggregation rather than materializing an unbounded ID list. Games
sorts group the existing indexed games, join real users, and retain zero-game
accounts. List/CSV Last activity matches the exact sort fallback (replay,
sign-in, signup). Count and truncation describe the export-start read; streamed
rows can change concurrently and are not represented as a database snapshot.

Final local proof with main725+726 integrated:

- API types pass;182 tests across12 suites (admin, ops console, rotation route)
  pass, including
  every sort/direction, filter boundaries, zero/orphan accounts, auth, actual
  10,001-account streamed cap, formula/CSV escaping, audit and event privacy.
- Web types and scoped lint pass;206 admin consumer tests across27 suites pass,
  including held-token auth transition and late-body filter-change exports.
- Required engine prebuild604e9d4618a6414b and production build pass. All bundle
  budgets unchanged: landing214.6/215, Today238.7/240, opponent476/500,
  Dock224.5/225, overlay234.7/240, widgets315.3/325 kB gzip.
- Actual shell/list/detail clientApi Chromium fixture:72 assertions at375/1440,
  light/dark; four synthetic loopback exports, all nonlocal traffic blocked.
  Eight captures in screenshots/admin-users-{list,detail}-{light,dark}-{375,1440}.
- Root reviewed grouping/count predicates, event privacy, CSV admission/cancel
  and links. Corrected the reviewed activity DTO/sort mismatch and explicitly
  stated count-time export semantics. Source/representative visual review clear.

Main725 and actual726 squash integrated cleanly (only725 additive changelog
conflict, preserving both entries). Final production build/budgets and responsive
recapture pass; all eight captures individually reviewed. Remaining: open/attach
scoped PR, review current-head CI/deployment gates and squash only when green.
Token Rotation726 merged c781b3402c76d4fcc12249af76a06621c34c2071 after all nine
GitHub checks and Vercel passed on eb7441a4; fresh main725 merge-tree was clean.
