# Build dialogs checkpoint

Branch `codex/wave5-build-dialogs` starts at frozen Execution
`9f59fa96`. The old Execution branch, its 47 current captures and all caches
remain preserved. The exact ten-path ownership manifest was recorded before
edits in `.cache/build-dialogs-owned-paths.txt`.

## Authored implementation

BuildDossierModal uses the existing Modal with size xl, currently
`sm:max-w-4xl` (896px), default phone sheet and internal content scrolling.
The shared labelled header carries the build name and its 44px Close replaces
the duplicate custom Close. Race/matchup, opponent/publication badges,
description, private notes and definition remain in the body. Practice, Edit,
Publish/Update, Delete, Full page and menu ordering are retained. The encoded
private matches path, slug, opponent perspective, preview/notes edit focus,
duplicate/re-match/publication callbacks and onChanged are unchanged. Manual
Escape and body-overflow mutation are removed in favor of existing primitives.

EditCustomBuildLauncher uses the same xl shell only for loading/error. Its
status region is busy only while pending; errors have alert semantics and a
visible Retry, while shared Close works throughout. Each load reuses the
existing useOwnerRequestScope with one 20-second bound across token lookup,
both GET responses and body work. Requests share cancellation; operation-local
peer cancellation also stops a remaining GET if its partner fails. The latest
runner stays in a ref rather than an effect dependency. Rendered state belongs
to the current owner/slug/intent scope object and retry attempt, so an account
or resource ABA cannot expose an older document for a render. Closing,
unmounting and replacement abort the active attempt; stale callbacks are
withheld.

Ready state still renders exactly the existing rich BuildEditorModal, directly.
Its edit locked slug, notes/preview focus, duplicate createOnly/private draft,
saved signature/reference/events, source replay, perspective, validation and
save/publication reconciliation are retained. Duplicate still skips the owner
publication GET. No editor, API or shared primitive contract changes.

BuildKebab registers its existing portal as a nonmodal focus scope. The parent
Modal owns Tab containment and the menu owns first Escape. Existing first/last
requestAnimationFrame focus, arrows/Home/End, placement, scrolling, actions and
conditional trigger restoration remain. Hook autoFocus and restoreFocus are
disabled to preserve the menu's ready timing and its dialog-action handoff.
Only its duplicate document Escape listener is removed.

Exactly the two retired dialog-outside-ui allowances for these consumers are
pruned. No replacement allowance or broad baseline regeneration is authored.
Help and changelog describe the user-visible Close/Retry/keyboard behavior.

## Authored regressions and validation boundary

New BuildDossierModal tests exercise the real shared Modal and BuildKebab with
an explicit synthetic Dossier boundary. They cover metadata/props/action order,
private notes focus, first/second Escape, scroll unlock and launcher focus
return. Existing BuildCard tests add parent Tab-domain and new-dialog focus
handoff assertions. Existing launcher render tests retain rich-editor save,
duplicate/private/provenance and publication cases, and add pending cancellation,
token/body timeout, Retry, single ready dialog, resource changes and owner ABA.
The synthetic auth fixture now exposes mutable, fully specified owner readiness.

Root independently reviewed all three production files, the focused test diff
and the existing owner-request helper contract before granting the serialized
slot. All 108 checks pass in 11 exact suites with at most two workers: Dossier,
launcher render/pure, BuildCard, Library, Detail, editor scope, Modal center/
nested and both focus-scope suites. The first whole type check found five
unsupported RTL ByRoleOptions.exact properties in the three changed test files.
Only those options were removed; string-name matching remains exact. The three
affected suites then pass all 32 checks and whole web types pass. The initial
RED type log is preserved; no product or compiler configuration changed.

Strict lint passes for six owned source/test/Help files without warnings.
The separate BuildCard audit has zero errors and its same two inherited JSX
click-wrapper warnings at line 538. No global zero-warning claim or waiver is
made. Help generation is deterministic for 89 articles; generated content is
unchanged and the original CRLF bytes/SHA256 are restored from a preserved
snapshot. All 19 UI rule tests pass; the 1,679-file ratchet has 654 existing
occurrences, exactly two fewer retired dialog allowances and no new or stale
allowance. Logs, suite manifest and JSON results are under
`.cache/build-dialogs-*`; `.cache/build-dialogs-static-proof.json` records the
boundary. Every launched runtime job closed and the slot was released.

Production build and actual-browser proof remain pending root's final scope
grant. Planned proof uses real DossierModal, launcher/rich editor, Practice,
menu and current shared AA with production CSS/fonts. It will check the 896px
desktop maximum and phone fit, real Practice child Escape/body locks, menu-first
Escape, and menu Edit through held loading to ready notes focus and close
return. Synthetic loopback responses will reject API writes and count/abort
nonlocal attempts, with new host/evidence paths that preserve old fixtures and
captures. Mocked-shell tests alone are not browser proof. No Git mutations,
provider/account operations, engine/native edits or budget changes occurred.
