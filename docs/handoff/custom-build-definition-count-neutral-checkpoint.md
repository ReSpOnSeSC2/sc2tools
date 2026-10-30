# Custom-build definition saves: local verification, release pending

The closed custom-build definition save and its linked game rename are locally
verified. Own exact-head CI, deployment and production acceptance remain
pending. This is an internal API prerequisite; the faster-dashboards parent
remains partial and caches remain off.

## Source boundary

Saving or renaming a custom build now runs as one owner-first statistics
transaction. A module-level `reserveCustomDefinitionSave` factory, backed by a
private WeakMap, reserves the writer slot before any await; the writer class
keeps its seven public methods. The reservation charges the same eight-slot
active/pending/drain accounting, captures the owner once and joins the original
FIFO queue through `gameWrite.finish` and its queue finally. A ninth concurrent
save on one writer is therefore refused with `game_stats_writer_busy`, as other
writes already were. The generic write path rejects the reserved descriptor.

The closed descriptor copies the definition data and the existing optional
CAS/history options before admitted work and accepts no query, update operator,
callback, session or neutrality flag. It requires a string, nonempty slug and a
number for an explicit revision, latches the first abandonment reason and
requires the captured owner to belong to the requested account. Its private
copy is deep-frozen and the descriptor is branded, so the in-transaction
re-check returns the issued descriptor instead of re-validating a clone that
may come from another realm. No length or range caps or coercion were added.

One owner-first transaction keeps the exact definition read and revision CAS,
the private save data and bounded history, both rename axes and the original
notification order. Only a strict protocol-2, maintenance-2 count/latest
preimage is carried; otherwise the count proof is retired without a recount.
This supplies no expanded chart seal, cache activation or savings.

Standalone deployments keep their compatibility path under the same owner: the
owner's maintained statistics are retired first, and only the exact initial
definition-read code 20 boundary allows the historical unversioned fallback. A
versioned admin save fails before any partial write. Session disposal failure
is logged as a diagnostic and never replaces a known commit, the primary Mongo
failure or an unknown outcome. This is documented behavior, not a claim of
perfect legacy parity for malformed input.

## Current local result

One admitted in-band batch passed 1,393 cases across 71 files with no
failures or skips, including 48 new unit and 43 new real-Mongo cases. The batch is
the 45 originally affected files plus 26 other suites that save custom-build
definitions or construct the custom-build service. Whole API types and
configured lint passed: four new files are strict-clean and thirteen changed
existing files add no diagnostics. All three commands and wrappers exited 0.
Cached Mongo 7.0.14 was used with downloads disabled; the batch took about
3 minutes.

Each command preserved 1,048 API inputs, 3,537 web inputs, the 7,040-file
full-source snapshot, dependencies/configuration and 49 raw assets. No new web
build or browser proof is claimed.

## Retained failures and corrections

All failed gates, their settlements and the reviewed corrections are retained.
No assertion, cap, timeout or skip policy was relaxed, and all 648 original
assertion-bearing lines in the seven earlier changed fixtures remain.

- The first gate failed whole API types with one TS2339 in the admin rename
  race spy. A type-only receiver assertion fixed it.
- The next gate passed types but failed configured lint. The fix removed an
  import left unused by the move to `customBuildDefinitionCommands.js`,
  restored a fixture callback's 231-line baseline and precomputed one
  real-Mongo test's per-mode expectations with identical values.
- The next gate passed types and lint, but its 45-file batch failed 129 of 991
  cases in five suites. Under Jest, `structuredClone` returns host-realm
  objects, so re-validating the issued descriptor inside the transaction
  rejected every transactional save. The unit harness also lacked the job
  collection, a fixture inserted owner rows without the unique clerk ID, and a
  fixture waited a fixed number of event-loop turns.
- Independent review before the next run found an unseeded owner pair masked by
  that fixture failure, and then three suites outside the batch whose fixtures
  could not save under the fenced path. Their fixtures were fixed and the batch
  was widened to every suite that reaches the definition save.

## Process settlement

The workstation rebooted between the pause and this run. A preflight then
stopped on seven unrelated processes reusing PIDs recorded by earlier,
pre-reboot checks. A declared boot-epoch rule settles only records whose whole
lifetime precedes the current kernel start, and requires every such PID
collision to be created after it. Records from this boot keep the unchanged
strict classifier. Final settlement covered 210 exact identities with no current,
historical, orphan or listener blocker, and no process was killed. A fresh
preflight preceded the heavy checks, which ran beside an idle StarCraft II
client without launching or stopping it.

## Integration

Commit `c16ae8fcad0ba9aeaf8c1549fa5035839ab8660b` records the tested source on top of the preservation commit
`c9d20a99d11c7095689662f8848a0d10910ea40c` (parent `059a168bb2619cc7c16625778ac99687ce39b353`), with tree `7796761a87fa1faad427e163319c3775313167fe`.
These documentation changes follow the recorded guards and do not touch
application bytes.

The [compact local receipt](validation/custom-build-definition-count-neutral/local-verification.json)
links the immutable source, results, retained failures and settlement proof.
The ledger stays at 197 items: 124 completed, 53 partial, 20 open, 73 remaining.
No cache flag, dependency, asset, provider or production state changes are part
of this slice.
