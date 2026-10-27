# Conditional personal-chart refresh checkpoint

Implementation applied and locally exercised on the ETag continuation branch as of
2026-10-27. The earlier source-only/UNRUN banner no longer describes this working
branch. Final fresh web types, strict manual-file lint and post-browser asset proof
now pass. Fresh-main integration and CI remain pending at this checkpoint. No production flag has been activated and no production saving is
claimed. The local results below were supplied by the root runner; this cache-only
documentation pass started no runtime.

## Scope and source history

The preserved revision 3 proposal is
`.cache/etag-manual-proposal-v3-3bfb3e1e`, originally based on main `3bfb3e1e`'s exact
tree `0a952dd6`, read from clean `wave3-my-reviews` head `eba82cf1`. Its original
14-path inventory and eight before files remain preserved; revision 1 and 2 packets
are unchanged. Source integration retains merged Device wiring and only adds ETag
to the existing CORS exposure list. It does not replace current `app.js` with the
old-base packet copy.

The validated build used source snapshot `adff3ab1…` and build ID
`iOeoqggg66dKKXC95IBnp`. Three new manual-only files were added later; the root
runner proved the original shipping bytes unchanged. Do not describe those later
manual files as part of the earlier production build.

## Retained server contracts

The existing default-OFF cache enables only when `USER_CACHE_ENABLED` is the
literal string `true`. The six eligible chart routes remain `timeseries`,
`dayHourHeatmap`, `lengthBuckets`, `activityCalendar`, `momentum` and `mapTrend`.
OFF/noneligible behavior keeps the original service/Express JSON path.

Completed entries provide process-salted weak tags over the typed
owner/filter/options/revision/generation key and exact serialized JSON. Validator
bytes share the existing reservations and retired response pins. Each subscriber
independently receives 200 or an explicitly empty 304 after the existing fresh
authentication, unique-owner/deletion and revision/generation guards. Retained
responses use `private, no-cache`; bypasses remain uncached 200 with
`private, no-store`. `Vary: Authorization` merges with CORS's Origin variation.
The bounded If-None-Match parser accepts weak comparison and sends ordinary 200
for malformed or oversized validators.

The server's logical retention limits remain 64 MiB of body/key/validator bytes,
512 entries, 512 KiB bodies, 16 KiB keys and an absolute ten-minute TTL. Admission
remains four active computations, two per owner, 32 waiting subscribers, 16
subscribers per key and 64 response leases. Queue and response deadlines remain
five and 30 seconds. Retired pinned bytes stay charged until response settlement.
These limits do not bound all Node/Mongo/transient memory.

The existing single-instance, settled-deployment and upgraded-writer requirements
still apply before an operator enables the optional cache. Process-local revision
guards do not establish distributed coherence for rolling overlaps or out-of-band
database writes. No authentication cache, gameStats maintenance, wider allowlist,
migration or activation is included.

## Retained client contracts

AppChrome supplies an auth/provider epoch. Only an explicit enabled-cache
capability on an eligible route starts the lazy client engine; loading, import
failure or an unavailable provider leaves one ordinary fetch. A cold capability
response is not retained. The next eligible 200 can provide a retained body/tag.

The engine retains immutable raw JSON text and uses a fresh JSON.parse for each
304. Keys capture the exact origin/provider/owner/full path, query and `#rev`.
Existing initiating-hook cancellation, Retry, SWR identity and previous-data
behavior remain unchanged. A still-mounted old-key operation can complete only
into its original key; switching one hook does not retire siblings. A→B→A and real
unmount retire old authority while StrictMode effect replay keeps it.

The logical 8 MiB ledger covers UTF-8 body/key/tag bytes plus 256 bytes per entry,
including retired pins and candidate reservations. Limits remain 64 entries,
512 KiB per retained body, 16 KiB keys, an absolute ten-minute TTL and four active
enhanced operations without a queue. Pressure selects one ordinary fetch before
enhanced API admission. Valid oversized 200 responses stay available. Pins and
reservations end with actual fetch/body settlement, including after caller timeout
or an ignored abort. The ledger does not bound decoder/text/DTO transients, SWR,
browser HTTP cache or total VM heap.

Missing, expired or mismatched 304 bodies permit one unconditional recovery; a
second raw 304 produces an explicit missing-body error with a Retry message.
Admitted reads, ordinary capacity/pressure fallback and unconditional recovery
share the same 401/403 notifier before error-body decoding. Rejection clears
capabilities, rotates the bounded retention token, retires pairs and prevents
held old-generation responses from refilling or reconstructing retired bodies.
Listeners remain registered for later capability rediscovery. This does not
retire account/SWR ownership or abort siblings. Oversized successful 200s retire
an obsolete older pair.

## Completed local validation

- API: 90 tests in seven suites passed with zero skips. API types exited 0.
  Strict lint reported zero errors and three inherited `app.js` function-length
  warnings; the exact baseline comparison had zero delta. All ten tracked API
  identities closed.
- Web: 156 tests in nine files passed with zero skips, including 27 engine and
  15 actual-useApi/SWR cases. Those subgroup totals are included in 156. Web types
  passed in run 02 and after the build. Six-file strict web lint exited 0. The
  final type/lint rerun after the last manual-fixture/spec edits is still pending.
  All 16 tracked test identities closed.
- Production build `iOeoqggg66dKKXC95IBnp` compiled in 34.1 seconds and generated
  146 static pages. All 81 unchanged route JavaScript caps passed. The validated
  shipping snapshot was `adff3ab1…`; later manual-only additions did not alter
  those existing shipping bytes.
- Native browser run 03 passed all four cases at phone width 360 and desktop
  width 1280 in 3.742 seconds, with zero skips, retries or flaky results. All four
  captures were viewed by the root reviewer. All 24 tracked identities closed,
  with zero owned listeners.
- Each of the four saved wire receipts records OPTIONS counts 11/10 and empty
  304 counts 3/5 across the two fixture origins, with zero errors or external
  requests. Both servers reported `listening: false` and zero sockets at teardown.
- Pre-build and post-build asset proofs agree for 40 canonical assets, seven
  active assets and four samples. Post-browser asset proof remains pending.

The API regressions cover exact validator bytes, malformed HTTP whitespace, mixed
subscribers, owner/auth/revision/deletion/unknown-write isolation, actual-app CORS
and bounded leases. Client coverage includes retained DTO isolation, missing-body
recovery, pressure, retired pins and actual SWR owner/sibling/revision/StrictMode
behavior. Capacity fallback 401/403 and unconditional-recovery rejection cases
retain their assertions, including retirement before a held error body settles.

## Browser proof boundary and retained failures

The native harness uses actual UserCache, UserRevision, `useApi` and SWR across two
local origins. Authentication, a two-row user store, DTOs and the fixture UI are
synthetic. The harness does not boot `buildApp` or Mongo. The separate 90-case API
group covers actual-app CORS; the browser results do not establish live Clerk,
production Mongo, provider behavior or production performance savings.

Browser run 01 failed its wire-preflight assertion because the installed
Playwright interception path synthesized OPTIONS 204 responses. All 12 tracked
identities closed. The repair removed all request routing and kept passive wire
observation and the original assertions, allowing native preflights to reach the
fixture servers. Run 02 then stopped on an exact `getByLabel` selector for Map;
all 13 tracked identities closed. The final selector uses the control's semantic
combobox name, Map. No behavior assertion, retry or skip waiver was introduced.
Run 03 is the passing result above; earlier failures remain retained evidence.

## Remaining integration and delivery

1. Final web types and strict three-manual-file lint passed; both groups closed
   all four observed identities. Post-browser admission again matched all 40
   canonical inputs, seven assets and four strict samples; its three identities
   closed with no listener. Pre/post proofs bind the same build snapshot.
2. Review and integrate fresh main `8fee…` after Tours merged. Preserve Device,
   Dock and Tours wiring and documentation. Move this changelog entry below the
   Device entry, preserving the pending Review `d32…` entry when it lands. Refresh
   the exact main/head comparison rather than relying on the old packet base.
3. Run the required exact-head CI and review its results before merge/delivery.
   Local validation does not establish CI or deployment success.

A later Sessions proposal may append a synchronous per-request publication guard
to UserCache.send. If integrated, that guard must execute immediately before OFF
JSON and every ON 200/304 write, including retained hits. This ETag change adds no
Sessions callback; reconcile that future overlap deliberately.

No production flag activation, authentication-cache change, migration, agent tag,
version bump or release has been performed as part of this ETag validation. No
speedup or reduced authentication-read cost has been measured or claimed.
