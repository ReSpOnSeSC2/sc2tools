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

Local proof before fresh-main integration:

- API types pass;76 tests across adminUsers/admin/adminEvents pass, including
  every sort/direction, filter boundaries, zero/orphan accounts, auth, actual
  10,001-account streamed cap, formula/CSV escaping, audit and event privacy.
- Web types and scoped lint pass;204 admin consumer tests across27 suites pass.
- Required engine prebuild604e9d4618a6414b and production build pass. All bundle
  budgets unchanged: landing214.5/215, Today228.4/240, opponent476/500,
  Dock223.1/225, overlay234.3/240, widgets314.9/325 kB gzip.
- Actual shell/list/detail clientApi Chromium fixture:72 assertions at375/1440,
  light/dark; four synthetic loopback exports, all nonlocal traffic blocked.
  Eight captures in screenshots/admin-users-{list,detail}-{light,dark}-{375,1440}.
- Root reviewed grouping/count predicates, event privacy, CSV admission/cancel
  and links. Corrected the reviewed activity DTO/sort mismatch and explicitly
  stated count-time export semantics. Final review/build/PR gates pending.

Remaining: integrate fresh main725, final combined build/budgets and responsive
recapture after the small wrapping/caption fixes, then create/attach scoped PR,
review current-head CI/deployment gates and squash only when all green.
Token Rotation726 remains independently owned at expected eb7441a4 while this
branch is active; never use this branch HEAD to merge726.
