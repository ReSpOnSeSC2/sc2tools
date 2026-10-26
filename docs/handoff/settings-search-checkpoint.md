# Settings PR A — field search checkpoint

Updated 2026-10-26. Local A3/A4 implementation and validation are complete. Root still owns integration, PR/full CI and delivery; no production rollout is claimed.

## Current behavior

- Settings search uses a static local tab/section/field catalog and aliases. Typing performs no server search, model call, private-value indexing or panel activation.
- Selecting an available result goes through the existing complete dirty/owner/action guard, then reveals the real admitted target. Stay retains drafts and the admitted URL.
- Registry availability follows actual modules, data, credentials and rollout gates. Inactive/private forms stay unmounted until admitted; selecting a target does not press its action button.
- Query, owner and token lifetimes fence stale callbacks, including A→B→A. Late code/data readiness rearms availability without undoing user cancellation or changing focus/scroll/URL.
- Overlay/Chat retain one shared token authority and the persistent selected tabpanel. Their controls and real form callbacks remain intact.
- Import all/admin/non-admin variants retain their existing gates. Worker, file-picker, clipboard and sign-out attempts are denied and recorded by the synthetic fixture.

This is Settings PR A only. Global palette/Cmd-K/PR B, additional providers and the rest of the roadmap are not included.

## Fresh formal proof

[Final A4 receipt](../../.cache/settings-search-current-search-proof-ee396805/final-a4-receipt.json), SHA256 `c3b9d8d9…`:

| Result | Actual |
| --- | --- |
| Cases | 20 passed, zero skipped/retried/flaky; 247.6 seconds. |
| Coverage | Light/Dark × 320/390/768/1280 main flows; delayed Profile/Backups/Hidden >8s, owner ABA and Import gates. |
| AA | 100 shared serious/critical scans with empty issue arrays; incomplete IDs retained. |
| Captures | 52 current synthetic screenshots, with a full hash inventory. |
| Transport | 416 typed GETs + 20 exact anonymous map reads; zero unknown/write/rejected/external/native attempts. |
| Cleanup | 46 sockets created/disconnected with per-case identity matches; all 20 case/final listeners drained/closed; zero owned children. |

Incomplete AA IDs are `aria-prohibited-attr` and `color-contrast`; shared gating does not establish zero violations at every impact. The [raw per-case evidence](../../.cache/settings-search-current-search-proof-ee396805/search/decoded-evidence/) and [screenshot hashes](../../.cache/settings-search-current-search-proof-ee396805/screenshot-sha256.json) are retained.

## Source and artifact provenance

- Test source: ee396805c2dc2c455d0e27ddba21ed13e4f705ca/tree3cf00778; pre/post guard passed 206 inputs, 68 feature paths and 863 exact pre-existing cache paths.
- Shipping app source: 5629fbace2e127c6d4f742492901c93fdd6087ac. The later ee delta changed only the Help selector and docs; app/fixture bytes are unchanged.
- Current artifact: ErWfIpWo99ntZ9ZQRPGOd, 145 pages; [build receipt](../../.cache/settings-search-checkin-proof-5629fbac/build/final-build-receipt.json) SHA256 `e964e67e…`.
- All 81 unchanged budgets passed: Settings 190.6/260, Help article 193.1/200, Community 188.6/190 kB gzip; post-build whole types and asset/source checks passed.
- Four actual CSS assets match the previous artifacts exactly. Current metadata `5e07c2e5…` matches previous -4h; original `6bcc46da…` only has an extra terminal CRLF. Neither metadata nor assets were reformatted to force equality.
- Post-browser checks retained all 40 engine inputs, nine own assets, four previously admitted sample payloads, pointer/manifest/availability, CSS, build and pinned Chrome bytes. No engine/sample generation, install, download, pruning or public-asset copy occurred.

The original A3 receipt remains [in place](../../.cache/settings-search-current-browser-proof-b14fdb19/sections/run-receipt.json), SHA256 `6f475d50…`: 12 cases/20 AA scans/20 captures at b14/201uu. [Bridge 2ed92262](../../.cache/settings-search-checkin-proof-5629fbac/build/a3-retention-proof.json) proves its unchanged actual dependency/render boundary and CSS asset equality. It was not rerun or relabelled as a current 32-case execution. Diagnostic1 and the earlier three partial passes are not added to fresh20.

## Static and CI collection boundaries

- Retained combined functional proof: 596 checks/74 files at 05a58c8a; later changes received targeted strict/types/source checks and the actual browser matrix.
- Final changed-spec strict lint: zero errors/warnings; whole-web types passed. Randomizer/Check-in class-only audits separately retain raw lint exit1 for their pre-existing label warnings at341:5 and166:5, with zero new warnings/directives/suppressed messages.
- Retained UI19/1706-file/639-allowance and Help92 deterministic-index proof are not represented as new full-suite runs. The named Theme scroll region keeps its documented one-line tabindex exception.
- [Default BEFORE/AFTER comparison](../../.cache/settings-search-default-after-prep-574641a1/comparison.json): 660→596 tests/33 files; exactly64 duplicate mobile/tablet Settings executions removed; all564 unrelated identities and32 desktop-owned identities unchanged. Later locator edits do not change titles/cases.
- Both specs already own their width/theme matrices. Only those two specs are ignored in default mobile/tablet projects; desktop retains every unique case. No test skip, timeout, AA exclusion or budget increase was added.

## Root-reviewed current captures

All four are synthetic actual-consumer fixtures using current production CSS/fonts. Copies are byte-identical, approved by root, with originals retained.

| Capture | SHA256 prefix |
| --- | --- |
| [Light320 search](screenshots/settings-search-final-light-320.png) | 872f1f5374cc |
| [Light320 Randomizer](screenshots/settings-randomizer-final-light-320.png) | bbae2ef3f802 |
| [Dark1280 Chat](screenshots/settings-search-final-dark-1280.png) | 1098654f74dd |
| [Dark390 Import](screenshots/settings-import-final-dark-390.png) | 30017a06c020 |

Full hashes and source/destination paths: [copy ledger](../../.cache/settings-search-final-docs-ee396805/screenshot-copies.json). The four approved PNGs expand the final owned footprint from68 to72; they do not change runtime code.

## Preserved failures and limits

The [full pre-rewrite history](../../.cache/settings-search-final-docs-ee396805/before-files/docs/handoff/settings-search-checkpoint.md), also preserved by ee396805, links all earlier compiler/setup, guard and selector REDs. Material packets remain unchanged:

- [Foundation list semantics](../../.cache/settings-search-current-search-proof-6733ef76/search/first-red-preserved/).
- [Invalid hex fixture input](../../.cache/settings-search-current-search-proof-be547a8c/search/first-red-preserved/) and [token-read scope](../../.cache/settings-search-current-search-proof-574641a1/search/first-red-preserved/).
- [Randomizer contrast](../../.cache/settings-search-current-search-proof-ebd72005/search/first-red-preserved/) and [Check-in contrast](../../.cache/settings-search-current-search-proof-78fa6a37/search/first-red-preserved/).
- [Desktop Help locator/three historical passes](../../.cache/settings-search-current-search-proof-5629fbac/search/first-red-preserved/).

Runtime is fully closed/released; product/Next/browser checks are stopped. Only these two concise docs and four approved PNG copies changed after the clean runtime postguard. Root owns integration/PR/full CI. No actual account/provider/permission/token/clipboard/StarCraft/native-agent action, new backend search API, migration, dependency, provider/model or budget increase is claimed.

Subsequent CI at `f99ffbe9` passed 9,153 web tests; the responsive job reported six legacy registry-fixture bundle failures from a missing `useSearchParams` export and was cancelled at its 20-minute limit. Commit `365adeb0` repairs only that fixture's URL-derived hook adapter. The six original local registry cases then passed, with 24 shared AA checks showing no serious/critical issues, no unknown/rejected/external transport requests, and all owned processes and listeners closed. The [focused receipt](../../.cache/settings-registry-browser-prep-365adeb0/proof/final-receipt.json), SHA256 `111caa4f…`, preserves the discovery-environment failure and unchanged ErW artifact evidence. Existing A3/A4 proof is retained; fresh integrated CI with Bank remains pending.
