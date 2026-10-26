# Connected-account disconnect confirmation checkpoint

2026-10-26. Source-only pack on `codex/wave5-platform-disconnect-confirm`,
prepared by root at actual main `4135639b`, in
`C:\SC2TOOLS\.worktrees\wave3-guides-expansion`. The merged UI branch,
screenshots, engine/sample assets and all prior caches remain preserved.

## First static verification

Root integrated reviewed Mobile source at `095de69a`, then ran the first
runtime stage. It passes 146 tests/16 suites, full web types, strict owned lint
on all five executable/Help files with zero warnings, deterministic Help90
without writing the index, all19 UI-rule tests and the unchanged ratchet of
1,695 source files/645 existing occurrences.

The original deadline test reached its body boundary nondeterministically
because the adapter imported the real request module during the fake clock.
The test now resolves that real function in setup and calls it directly during
the request, preserving real JWT/header/body handling. The nonheld DELETE uses
the actual API's204 response. Original test bytes and both RED logs remain
under `.cache/platform-first-static-095de69a/`; no production source changed.
All41 connected-account tests and all original assertions pass.

All root runtime jobs are closed. Final dependency integration, build/admission,
browser/AA and delivery remain. No actual provider/account operation ran.

## Initial source-only boundary (historical)

The exact eight paths were recorded before edits in
`.cache/platform-disconnect-confirm-owned-paths.txt`. No unit test, types,
lint, Help generation, build, browser, Git mutation or provider/account action
has run for this pack. The source hash manifest is
`.cache/platform-disconnect-confirm-source-only-sha256.json`. Root owns Git
and runtime scheduling. Previous UI proof does not validate this new pack.

## Scope and consent

OfficialPlatformConnections uses existing leaf `useConfirm` and ConfirmDialog
instead of its one native confirmation. The dialog names Twitch, Kick or
YouTube, warns that disconnecting stops both notifications and stream controls,
initially focuses Cancel, and requires the named danger Disconnect action.
Cancel, Close, Escape, scrim, unmount and retired contexts cause no DELETE.
Only one decision/request may be pending for a scope.

The scope is an object epoch formed from the ready Clerk owner and the fixed
three platforms' connected/connectedAt revision tuples. A change retires the
old epoch immediately, including owner and revision A-to-B-to-A transitions.
The request controller is aborted on retirement/unmount. Existing
useOwnerRequestScope supplies the captured owner/JWT fence; resource identity
is rechecked before and after each token and response. A missing JWT does not
send an anonymous DELETE. The 20-second whole-request deadline starts after
human approval and includes token lookup, DELETE and the single status GET,
including their response bodies.

The explicit status GET replaces the former revalidation read, keeping its
endpoint/read count. It must return a well-formed three-platform status DTO
with the selected platform explicitly connected:false. A still-connected,
missing, invalid or duplicated target is an uncertain result, not success;
it takes the existing status-check recovery without extra reads or mutations.
Accepted fresh status seeds the owner-bound SWR cache
with revalidation false. An operation may admit exactly one expected revision
successor from that cache publication. Any other resource transition retires
the operation permanently, including reconnect-to-expected ABA while the cache
acknowledgement is held. The updater also checks the supplied cache revision,
so a newer cache row is retained even before React renders its new scope; a
mismatch or cleared/invalid cache retires the operation. Empty data cannot
masquerade as the expected disconnected snapshot. Invocations after retirement retain the cache.
Post-acknowledgement success requires an admitted publication, the captured
owner and the exact admitted operation/successor identity. Controller and busy
ownership transfer only to the one expected successor. A scoped disconnect
busy state cannot disable or clear the next owner's action. Uncertain DELETE/status results offer honest status-check
guidance and never automatically retry a mutation; a new attempt requires a
new explicit approval. This is a client lifetime guard using observed public
connection revisions, not a new server-side conditional-delete contract.

Connect and Reconnect retain synchronous popup creation, polling, callbacks,
scope-purpose bodies and separate notification/stream-control permissions.
No primitive/API/provider contract, permission, dependency, migration, agent
release or budget changes. Only OfficialPlatformConnections' one retired
native-confirm baseline entry is removed. No other CTA or dialog migration is
included.

## Authored proof, not executed

The existing streaming suite retains all nine connection/purpose/permission
cases, with a faithful ready-owner Clerk fixture. New cases use the real
owner-request hook and real apiCall JWT/header/body handling over stubbed fetch.
They cover every safe dismissal/focus return; exact one DELETE plus one status
read/cache seed; repeat approval; failed DELETE or status refresh requiring new
consent; missing JWT; pending owner/revision ABA, auth loading, sign-out and
unmount; retired held JWT/body delivery; and held token/DELETE-body/status-body
deadlines with no later mutation, cache update or toast.

Root's independent source review found an earlier owner-only post-cache check
could report stale success after a same-owner reconnect during a held cache
acknowledgement. The original component/test bytes and SHA256s are preserved
in `.cache/platform-disconnect-before-cache-ack-review`. The expected-successor
repair above adds real consumer regressions for reconnect and
reconnect-to-expected ABA, including a delayed updater retaining newer cache.
Peer source review then found that the updater needed to check its supplied
cached revision before React could rerender it. A third held-cache case covers
that ordering and verifies the retired callback cannot revive on expected ABA.
A further cleared-cache case rejects undefined instead of normalizing it to
an all-disconnected revision. Root also required contradictory status cases:
DELETE acknowledgement alone never announces success when the authoritative
follow-up still reports connected or lacks a valid target. Unit and synthetic
browser fixtures cover these recovery paths without an automatic retry.
This is a source-review finding and authored repair, not an executed RED/GREEN
claim. Runtime verification remains outstanding.

The two new browser files use the actual consumer, clientApi/SWR, useConfirm,
ConfirmDialog, Modal, Toast and current production CSS/local fonts. Only auth
and transport are synthetic. They record typed owner-specific GETs and exact
test-armed DELETEs; unknown requests, unapproved writes, external traffic,
native confirmations, popups and websocket attempts are denied and counted.
No real provider, permission, integration or account can be acted on.

Authored browser cases exercise safe initial focus, Cancel/Escape/scrim,
Tab/return focus and nested Modal Escape/body locks; owner/revision retirement,
held JWTs, exact approved read/write counts, and explicit reapproval after
uncertain results. Light/Dark 320/390/1440 captures include full AA and dialog
bounds/44px-control checks. The existing provider trigger is still Button sm
(36px high); only shared confirmation controls are claimed to meet 44px here.
No screenshots are yet owned or copied by this pack.

## Remaining gates

Root independent source review, then an explicit serialized runtime grant for
focused consumers/useConfirm/Modal/private-request tests, whole types, strict
owned lint, deterministic Help generation and UI ratchet. Retain all real RED
results; do not weaken consent, auth, count or AA assertions. Any broader file
scope needs root approval.

Current engine/sample admission, a current-source production build, unchanged
budgets/post-build types and pinned one-worker actual browser proof remain
unexecuted. No compiler/publisher/pruning/download is authorized by this pack.
Current-main reconciliation, exact-head CI, reviewed commit/PR/merge and live
verification belong to root and remain outstanding. This pack does not finish
the overall UI roadmap.
