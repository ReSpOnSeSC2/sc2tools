# Export center UI checkpoint

Item 78 A/B/D1/D2/D3/E is implemented in the UI candidate. This checkpoint records the implementation and its remaining acceptance work; it does not mark the roadmap item complete.

The existing `build-exports-checkpoint.md` covers earlier per-game/build formatting work. It does not describe this account export and replay-pack flow. This document adds that handoff without changing the existing 56 UI source files.

## Account and build-order exports

Settings → Backups & data exposes an Export section. The full account archive streams NDJSON with optional game details. Metadata, owner identity and the terminal completion record must validate before successful publication. The internal API user identifier used in archive metadata is distinct from the Clerk identity used to cancel stale browser work. The legacy JSON action remains available. Exports are private account copies, separate from restorable snapshots and redacted support bundles.

The optional export before account deletion uses the same export mechanism. Feedback and Cancel are visible inside the deletion dialog. Export success, failure or cancellation does not itself confirm deletion; the existing explicit deletion flow remains separate.

Build orders support CSV and NDJSON, up to 2,000 games per page. Unrecorded supply stays null in NDJSON and blank in CSV. From and Through are local calendar dates: From starts at local midnight, and inclusive Through ends at the next local day's start. The API permits three admitted requests per rolling hour. Each admitted page or explicit retry counts, including a later failed or cancelled download. A picker cancelled before admission does not spend a page request.

Continuation is bound to owner, effective filters and format, with a nonrenewing 24-hour lifetime. A failed or cancelled next page retains its same-scope token for a manual retry. A successful page replaces or clears it; explicit first-page restart and owner/format/date changes clear it. There is no automatic page retry. Records are read sequentially, so these exports are not transactionally frozen account snapshots.

## One browser reservation and actual cleanup

Account archives, build orders and replay packs share one browser export reservation. The save picker is invoked synchronously before JWT work. Direct file output is preferred when offered; the completed in-memory fallback is capped at 128 MiB and exposes no artifact before successful close.

Owner, committed query, selection revision and job nonce are captured through finalization. An A→B→A account or query transition creates a fresh lifetime; it cannot restore old work or feedback. Repeated clicks cannot replace the active cancellation controller. First failure/cancellation cause remains fixed, and feedback contains closed private messages rather than transport exceptions.

Local cancellation does not release admission until the actual picker, JWT/API work, readers, worker output and sink abort/close cleanup settle. It does not prove that a remote API lease has already settled. Cancellation also cannot instantly undo bytes already committed by a browser's direct writer.

## Bounded replay ZIP and controller

The ZIP implementation uses store-mode ZIP32, CRC32 and UTF-8 names, with at most 100 original replay entries plus reserved `manifest.csv` and `README.txt`. Originals are capped at 5 MiB each. Worker output chunks are capped at 64 KiB, with one pending sequence acknowledgment and output backpressure. NACK, abort, fatal errors, message deserialization errors and constructor/startup failures have explicit cleanup paths.

A ready worker cooperatively reports terminal protocol settlement. Before readiness or after an owned fatal error, native `Worker.terminate()` is a termination request: the browser API provides no termination-complete promise or invented close event. The client still joins actual admitted main-thread writes, close and abort operations. It does not claim that requesting native termination observes worker-thread completion.

The controller consumes the API's ordered version-1 batch response and exact counts. Available rows have the seven fields `gameId`, `status`, `url`, `filename`, `sizeBytes`, `issuedAt` and `expiresAt`; no owner or digest field is invented. Original retrieval requires actual HTTP 200 and exact EOF byte counts. HTTP 206, short bodies and oversized bodies fail the file. Content-Length is not trusted as proof of complete bytes.

At most four selected replay slots are signed/read together. Their actual reads settle, then the controller writes them in selection order and awaits D1 acknowledgments before admitting a fifth. An unstarted expired link may be refreshed once under the same scope, with its refresh flag reserved before re-signing. Started failures, busy responses and unknown errors do not retry automatically. Signed GETs carry no ambient cookies, authorization headers or referrer. Owned worker failures also abort sibling readers while idle between entries.

Completed partial packs retain ordered saved/unavailable/failed results. Only complete originals are marked saved. Cancellation never automatically publishes a partial ZIP. The manifest contains bounded selected metadata, safe filenames, a recorded match result and a separate download status; it excludes signed URLs, tokens and storage paths. README records counts and privacy guidance.

## Selection, names and help

Replay-pack selection is an independent map of at most 100 games. The existing destructive hide/delete selection remains confined to the ordinary page of at most 25 games. Moving between pages preserves pack choices only within the same owner and committed filter scope. Pending filters and stale SWR list data are inert.

Select matching makes one existing list request with limit 100, current filters/sort and no enrichment or continuation cursor. It validates the raw bound before deduplication and atomically replaces the prior map only after the complete response is read. Failed or cancelled same-scope selection retains prior choices. It never merges repeated groups of 100 or follows more pages.

Filename options retain date/opponent/map, date/matchup/map and Game ID variants. The descriptive option includes date, matchup and the recorded Win/Loss/Tie/Unknown result, followed by opponent and map. Result is captured before asynchronous work and is never derived from download success. Names are normalized and sanitized, capped at 240 UTF-8 bytes, checked for case-folded collisions and forced to `.SC2Replay`; reserved metadata names cannot be used by originals.

Settings links to the lazily loaded Replay Library pack controls. Help covers the Export anchor, replay-pack selection, progress, partial results, cancellation and privacy. Only the official generated help index was refreshed. Original replay files may contain identifiers, chat and team information; a pack is not anonymized or redacted. Temporary links already issued can remain usable until their one-minute expiry after cancellation, deletion or unlinking.

## Evidence and remaining acceptance

The D3-02 dirty-development UI run passed 325 assertions across 37 unique modules with no skips. Its development quality run passed types, configured lint with zero errors/added messages and seven inherited warnings, UI rules and UI lint. Those are historical development results at UI base `172903660c64e00209efee642d4cd81390867112`; they are not final clean-head acceptance for this document or a later merged candidate.

The UI33 mutation preparation has four partitions of 8/10/7/8 cases. The unbound template's static reviews cover separate fresh baselines, exact selected matcher classification, actual child-close/raw-restoration guards, dual default/JSON global-error screening and ordinary timer-frame handling. Constructed classifier examples are separate from actual tests. No UI mutation baseline or kill is claimed. Safe negative coverage gaps for fifth-slot admission, expiry/refresh flags and some cursor/selection variants remain recorded rather than counted as kills.

PR #873 merged the API candidate as fbf827394b405fa51f66b57cd2c55f16abe993ec on 2026-11-03; this UI worktree was then integrated with that main commit. At the integration checkpoint, main delivery was pending. Final UI acceptance requires a reviewed clean UI commit, fresh required target/quality/full-web/build/budget/mutation checks, independent outcome audits, hosted CI and delivery. The new document and successor source freeze need independent review before a future commit. The 49 protected raw pins, 40 canonical inputs, seven served assets, four strict sample games and all route budgets remain preservation requirements.

Browser GET/CORS provider readiness is externally unknown. The dormant GET policy does not activate a provider/configuration change and does not change existing automatic upload/PUT checks. Operators must verify browser GET access for the deployed site origin before announcing pack availability. Successful uploads, unit mocks or individual signed downloads do not establish that acceptance. No live provider, signed-in account, native-agent or production-setting change was made for this UI slice.
