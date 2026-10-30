# Opponent region and identity writes: local verification, release pending

The opponent region stamp and the opponent identity heal are locally verified as
closed count-neutral writer families. PR821's squash `de2031ad` is merged into
this branch without changing its tree; its own exact-head CI, deployment and
production acceptance are pending. This is an internal API prerequisite; the
faster-dashboards parent remains partial and caches remain off.

## Source boundary

Two fixed families replace the opponents service's direct game writes: a region
stamp (`updateOne` on one game) and an identity heal (one `updateMany` over the
owner's games for an exact opponent key). Both keep the original filters and
`$set` paths, add an explicit no-upsert option and never write MMR, league,
lookup markers, dates, membership or schema fields. Literal strings, including
empty and leading-dollar keys, are kept without trimming, caps or coercion.
Descriptors are fresh in-module literals branded in a WeakSet, so the
in-transaction re-check returns them as-is.

Every write goes through the per-database statistics writer with an owner-first
claim. Only a strict protocol-2, maintenance-2 count/latest preimage is carried;
otherwise the proof is retired without a recount. Standalone deployments retire
the proof first and require an acknowledged single match before the fixed game
command, and a writer that stops in between never dispatches it. Existing
families keep their behavior.

The four producers copy their consumed inputs and admit one owner before their
first database or SC2Pulse call. Ingest forwards its batch owner to both
`recordGame` and `refreshMetadata`; only omission permits a single bounded
capture, which is never charged to the writer's eight slots or its drain. Calls
that cannot stamp perform no capture. Repairs forward their genuine fence by
name, and only the backfill entry accepts that context.

Genuine `repair_opponents` and `admin_rebuild_opponents` claims now issue a
process-local, deny-only liveness handle. A renewal failure, a failed assert or
the start of a release closes it for good. Fenced heals re-check it after the
read floor, after the owner claim, on every transaction retry and immediately
before the fixed command, using the exact fenced owner/epoch/kind predicate. A
failure first seen after dispatch cannot cancel a commit, and lease expiry or
loss in another process remains unproved.

Every veto keeps the existing warning and void or zero result. A failed heal
still has no durable retry marker.

## Current local result

The recorded gate passed whole API types and configured lint: eleven new files
are strict-clean and nine changed files add no diagnostics. The 214 affected
files passed 3,056 cases in four serial in-band chunks with no failures or
skips, including 159 new cases (82 unit, 77 real-Mongo). Cached Mongo 7.0.14 was
used with downloads disabled, and no owned server outlived a run.

## Review, corrections and retained failures

An independent read-only review covered the contract, the brief, adversarial
correctness and test adequacy. It confirmed five blocking findings, which were
two missing planned tests and no source defect. Both are now covered, along with
the background renewal mark, a context dropped at the GDPR entry and the
producer-level failure mappings. Seven deliberate regressions, each one the
review said would pass every suite, now fail. Twenty-seven findings were fixed,
eight accepted with reasons and one noted. One hardening came from the review:
ordinary producers refuse a repair context.

No assertion, cap, timeout or skip policy was relaxed. Retained failures: the
first real-Mongo producer run failed 19 of 41 cases on test-side issues and left
its own jest process open, which was stopped after its ownership was verified.
The single in-band batch exhausted the unchanged 2 GiB heap after 160 passing
files, so the gate runs four serial chunks with identical flags. One mutation
attempt aborted on a line-ending mismatch and was restored before the corrected
run.

## Integration

Commit `5dc7423504b0a6a13b901f3d386e947d1ba12513` records the tested source on top of PR821's head
`bd25dae1ae352dc1ebdf87e274e4734739af4625`, with tree `d0c1349d4bb05144e073595f41727f33855f2019`. The committed blobs equal the gate-tested
bytes. After PR821 merged, `main` (`de2031adcf4cc7a0cfe3e18cfae0ff0a3891b49e`) was merged into
the branch as `e417031b53a907936a440dd653469393428266d0` without changing its tree, and the tested
source commit is unchanged. These documentation changes do not touch
application bytes.

The [compact local receipt](validation/opponent-game-region-identity/local-verification.json)
links the immutable source, results, review and mutation evidence. The ledger
stays at 197 items: 124 completed, 53 partial, 20 open, 73 remaining. No cache
flag, dependency, asset, provider or production state changes are part of this
slice.
