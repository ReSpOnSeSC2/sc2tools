# Replay Review lifecycle verification — 2026-10-27

Review drafts and pending actions now follow the initiating account and replay.
Account changes retire held token/body work before it can submit, navigate,
download a replay or clear another account's draft. Legacy ownerless drafts
are not restored; existing bounded expiry and pruning remain.

Saving a comment or closing a request can succeed while the following thread
refresh fails. The UI reports that state and offers a GET-only Retry. Closing
immediately removes playback, downloads and composers. API compare-and-set
guards preserve closed/removed/hidden state during answer, cleanup and ranking
races. Admin preview reads are private/no-store; public reads retain their
existing TTL and append Authorization to CORS's Vary: Origin.

## Verified locally

- Web: 182 Review/consumer/Help tests; an additional 19 targeted tests after
  correcting unsupported test query options. Final fresh web and API types pass.
- API: 138 tests in 15 suites, including real Mongo lifecycle/privacy/permissions
  cases and 28 cache/CORS contracts. The final group exited 0; all 36 observed
  process identities retired with no owned listener.
- Public browser: 12 cases passed at 360/1280, no skipped/retried/flaky cases.
- Authenticated lifecycle browser: four cases passed at 360/1280, no skips,
  retries or flaky cases. Creation, saved-mutation refresh recovery, editing,
  replies, helpful/best/votes, replay sharing, completed file download, close,
  reload, permission gates and account-specific drafts are exercised. The final
  run took 11.039 seconds; all 30 observed identities retired, no owned listener.
- Browser tests use real components/SWR/hooks with synthetic Clerk/navigation
  and API boundaries. The download uses a bounded ephemeral loopback HTTPS
  listener and a constant fake replay file, with an exact public test-key pin.
  Test certificates are never installed in an OS store. Live accounts/providers
  and production writes are outside this verification.
- Own production build M5Nu8SDWPp5C9BZkUvbRg: 146 static pages and all 81
  unchanged route budgets pass. Shipping web bytes remain identical to product
  commit 74407abe; subsequent changes are test-only. The separate API CORS
  addendum has its own final API test/type proof.
- Prebuild/postbuild/postbrowser admission agrees on 40 canonical engine inputs,
  seven active assets and four existing strict-schema sample games. Nothing was
  generated, downloaded, pruned or released.
- Changed-file web lint: zero errors and the same two inherited Ask-button test
  warnings. API lint retains four inherited long-function warnings. Raw strict
  failures and baseline comparisons are retained; no warning waiver was added.

## Evidence and delivery

Local evidence is preserved in
`C:\SC2TOOLS\.cache\review-verification-20261027`, including original failed
assertions, type/lint diagnostics, traces, immutable run reports, input hashes
and identity/listener closure receipts. The first synthetic attachment route
could not complete a Chromium download. The first real HTTPS run exposed early
certificate probes; the final worker pins only the public local test key and
keeps the error/rejection ledger assertions strict. Playwright's fixture callback
was renamed to avoid React's hook-name lint rule; the final browser run includes
that source.

CI, fresh-main merge review and deployment observation remain required before
claiming this change shipped. No production migration, integration activation,
native launch/release, version bump or release tag is included.

## CI loader correction

The first integrated CI build passed its unchanged budgets, then browser
collection failed before any tests: the repository TypeScript config uses a
CommonJS loader, unlike the earlier local ESM config. Certificate lookup now
uses the fixture's existing web-working-directory convention instead of
import.meta. The actual repository config discovers all six cases. A pinned
CommonJS-style local run passes all four phone/desktop lifecycle cases in
10.888 seconds, no skips/retries/flaky cases; all 28 observed identities retire
with no owned listener. Changed-file lint again reports zero errors and the
same two inherited warnings. The original CI failure is preserved. Application,
server, certificates, assertions and download trust pin are unchanged.

## Consumer and tablet CI corrections

The full d32 web suite passed 9,304 tests and failed two older replay-table
assertions that expected the raw token callback. The replay-table fixture now
invokes the scoped callback before resolving its POST and verifies its token,
live AbortSignal and wrapper identity. Original game/question/row assertions
remain. The three-file consumer group passes all 40 tests; fresh web types and
strict lint of the changed table/fixture files pass.

The same head's browser suite passed 559 cases, with 92 existing skips, and
failed only the two tablet lifecycle cases at exactly eight pixels of overflow.
The synthetic host used p-4 at every width while the actual AppChrome wrapper
uses sm:px-6. Matching the real wrapper fixes this test boundary without hiding
overflow or changing the <=1 assertion. The new local CJS run includes all six
phone/tablet/desktop lifecycle cases: six passed in 16.292 seconds, no skips,
retries or flaky cases. All 43 observed identities retired with no owned listener.
Both original CI failures remain retained. These corrections change only tests
and this checkpoint; production implementation bytes remain unchanged.
