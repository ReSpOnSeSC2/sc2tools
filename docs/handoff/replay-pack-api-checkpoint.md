# Replay-pack API source checkpoint

This is item 78 C source work on `codex/export-center-stream`, based on delivered main `172903660c64e00209efee642d4cd81390867112`. Source review, runtime checks, mutation kills, clean-head acceptance, CI, merge and delivery remain pending. Item 78 is not complete.

## Request and response

`POST /v1/replays/download-batch` uses the existing replay-files router and authentication. Its body is exactly `{gameIds}` with 1–100 raw primitive string entries, each 1–200 UTF-16 code units. Validation checks the entire raw count before normalization or duplicate detection, rejects control characters, malformed UTF-16, URL forms, empty values, normalized duplicates and unknown body fields, and returns a defensive frozen selection. It captures the authenticated internal owner once. Body-provided owner, bucket, URL and expiry values are rejected.

The version-1 JSON envelope is `sc2tools-replay-download-batch`, with ordered `items` and `counts` (`requested`, `available`, `unavailable`, `retryable`). Available rows contain `gameId`, `status`, `url`, `filename`, `sizeBytes`, `issuedAt` and `expiresAt`. Other rows contain only `gameId`, `status` and a fixed code. Missing, foreign, permanently deleted, deletion-pending, resumed and unavailable-marker rows share `unavailable` / `replay_unavailable`. Unknown storage/signing failures use `retryable` / `replay_download_unavailable`; aged-out URLs use `replay_download_expired`. No raw storage errors, internal owner, marker values, object keys or bucket data enter these failure rows.

URLs are ephemeral response credentials. They do not belong in logs, histories, manifests, README files or support bundles. URL fields have a 4,096-character cap, filenames 255 characters, encoded rows 8 KiB and the encoded body 1 MiB. This bounds this API response; it is not a claim about total process memory or future ZIP memory.

## Admission, cancellation and truth

The route shares the existing process reservation with legacy account JSON, account NDJSON and both build-order formats. Busy is a fixed 503 before selection reads, signing or build-order quota work. There is no queue or new operational quota. The reservation remains held until actual work settles and HTTP terminates. A 60-second request deadline stops future admissions but does not release a held non-cancellable signer or other admitted operation before it settles.

The service uses at most four actual workers and at most 100 ordered slots. Each worker awaits the real Mongo/HEAD/signer operations it admitted; cancellation joins all workers through `allSettled`. Mongo cursor reads receive the cancellation signal and a 5-second `maxTimeMS`; supported SDK HEAD calls receive `abortSignal`. The pinned Mongo driver does not support `signal` in `UpdateOptions`: the 5-second marker CAS keeps its private comment and pre/post cancellation guards, and its actual non-cancellable promise remains awaited. Signing/credential resolution is awaited even when it ignores cancellation. No timeout race releases the reservation.

Pack eligibility is owner + LIVE + not resumed. Hidden and excluded owned live originals remain eligible, matching the existing individual download behavior. Individual upload/download payloads and configured individual URL expiry remain unchanged.

Each pack read projects only the six known marker fields plus the existing filename context and computed BSON field types. The bounded identity preserves exact presence, primitive values, Date versus historical-string representation, and actual BSON numeric types for `version`, `uploadId`, `sizeBytes`, `sha256`, `md5`, `storedAt`. Optional legacy absence is represented by `$exists:false`, never equality to null. Malformed present fields fail closed. Expression `$type` guards avoid Mongo query `$type` accidentally matching an array element. The same captured predicate guards stale-marker CAS and the final owner/LIVE/not-resumed lookup.

Only a genuine named object-missing result or verified size/SHA mismatch may CAS-clear that captured marker. Access-denied, transport, timeout, bucket errors, ambiguous generic 404 and malformed HEAD responses remain retryable unknown and do not clear it. A same-timestamp, same-content replacement with a changed upload ID, version, MD5, field presence or BSON type is not cleared or adopted.

Pack signing always supplies an explicit second-rounded `signingDate` and 60-second expiry. Results already expired after held signing/final lookup, or while other batch slots finish, are discarded before publishing the response. Final eligibility is the last observed Mongo state after signing, not an atomic cross-store revocation lease. Already-issued bearer URLs cannot be instantly revoked by cancellation, unlinking, filter changes or later deletion. Legacy markers have only their captured known fields and presence; no unique generation is invented for them.

## Privacy integration

An early exact route matcher sets `private, no-store` before helmet, CORS, rate limits, JSON parsing and authentication. A route-specific JSON parser preserves the ordinary 256 KiB limit and default JSON content behavior, replacing parse/size/charset/encoding failures with fresh fixed errors before logging or optional SDK handlers. The final route boundary handles auth and other failures without retaining raw causes or parser bodies. Case and optional trailing slash match Express; neighboring paths retain their existing behavior.

The exact batch POST is a read exemption from `withUserDataWriteFence`, alongside the existing private-search read exemption. It does not claim or renew `_dataMutations`; uploads and other writes keep their fences. “Zero IO for bad selections” means no replay selection/storage/signing/build quota or new data-mutation lease. Preexisting authentication resolution may still perform authentication IO.

Optional telemetry hooks ignore early batch body/span capture, drop private request/transaction events including both request copies, and retain a constant isolated scope tag and safe-error identity for events without a URL. HTTP operational serializers already exclude request/response bodies. Each initial/final Mongo read and marker CAS carries the same constant identifier-free private comment; driver command-failure logging emits a fixed code, without echoed query data.

The exact batch operational log URL also drops every ignored query field and uses its canonical path. Review found that arbitrary caller-supplied query values could otherwise be retained by the generic logger; this is not evidence that normal generated signing URLs were logged. Malformed SDK metadata shapes are retryable unknown without cleanup. Valid missing metadata, an empty metadata map or a wrong string SHA remain verified absence/mismatch eligible for captured-marker CAS.

This required a deliberate C change to the previously reviewed A/B `app.js` pin. Combined integration quality also factors build-order service attachment and catalogue/export router registration into small helpers, preserving the service dependencies and router placement while avoiding rising inherited function-length warnings. The other 20 A/B source files remain unchanged. A/B receipts still describe their historical exact source and are not relabeled as current C acceptance.

## GET CORS boundary and remaining work

`replayDownloadCorsPolicy` is dormant pure policy: prospective GET rule, independent coverage, non-destructive merge and a separate status projection from explicitly supplied dated GET-check facts. It uses a distinct managed download-rule ID, preserving PUT, unrelated and ID-less rules. Desired rules or PUT readiness alone never imply GET readiness. No runtime path imports this policy, calls a new provider probe, writes bucket configuration, changes flags or starts a new SDK/provider service. Existing upload `desiredRule`, automatic PUT repair, startup and passive status call graphs are unchanged.

Actual bucket GET CORS, permissions and browser fetch acceptance remain unknown owner/external gates. Individual anchor-download success does not establish browser-fetch CORS. Browser ZIP/selection/help work is separate; it must request only ready slots (normally at most four), use bounded fetching/output and owner/job fences, and avoid aging 100 eagerly signed URLs. No production replay-pack readiness, owner acceptance or item completion is claimed here.

The added source regressions cover raw validation; disposable-Mongo ownership/visibility and full-marker rotations across held HEAD/signing; real four-worker and cleanup settlement; shared account/build/batch admission; explicit expiry and response caps; real app parser/auth/rate behavior; exact read-fence exemptions; optional telemetry and private DB logging; dormant GET policy; and unchanged individual download contracts. These tests are authored, not yet executed at this checkpoint.
