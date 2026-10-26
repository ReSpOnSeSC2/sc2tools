# Build dialogs checkpoint

Current source on `codex/wave5-build-dialogs` is locally validated and frozen
for root's Git/PR delivery. Root preserved the reviewed repairs at `1d8c9976`
and normally integrated actual main `1ad5dafa` at
`65f18e9a54435b77a7bef0917be6b9e9eca44894`. The final artifact additionally
includes the approved one-line Modal header sizing repair and measured browser
regression. All runtime jobs, browsers and loopback servers are closed; the
exclusive runtime slot is released. No production publication is claimed.

The agent-owned manifest is exactly 19 paths in
`.cache/build-dialogs-owned-paths.txt`: eight production files, five test files,
two manual runners, Help, the two-entry baseline pruning, changelog and this
checkpoint. It grew from the original ten paths before each approved scope
addition. Root separately owns the active program checkpoint and three planned
final screenshot copies. Neither is included in agent source-lint counts.
The old Execution branch, all 47 original captures, engine assets, failed
attempts and earlier cache/evidence directories remain preserved. This closes
this consumer pack's local proof, not the entire shared UI roadmap.

## Current final proof

Final build ID: `IEITieCYZv_TgSINF0W0I`. Direct Next production build succeeds
with 143 generated pages using official dummy/local responsive-CI flags.
No npm prebuild, engine compiler, publisher, pruning or download runs. All 81
unchanged budgets pass (18 listed routes plus 63 default routes); post-Next
whole web types pass. Representative actual/budget kB gzip: Community
188.6/190, Guides 173.4/175, Today 234.3/240, opponent 458.9/500, Builds
202.9/270, Dock 216.7/225, widget 318.2/325 and Try 216.7/240. No limit changes.

All 204 checks pass in 20 exact suites, with at most two unit workers. This
includes the 150-check/14-suite dialog/Modal/Practice/phase/rule consumer pack,
merged-main ShareLink and Definitions consumers, and four Help contracts.
Whole web types pass before and after the final build. Strict lint passes for
11 owned code/test/Help/manual files with zero warnings. A separate five-file
audit has zero errors and nine unchanged warnings: BuildCard:540 and Practice
controller:99/test:21 click-wrapper warnings, Basics:155 label association, and
Rules:330/545 redundant list roles. No waiver or unrelated warning refactor.
Help generation is deterministic for 90 articles; exact original CRLF bytes
are restored after content equivalence checks. UI rule tests pass 19/19; the
1,693-file ratchet reports 651 existing occurrences and no new/stale allowance.

The final actual-Library browser matrix passes 329 checks, 48 captures and 48
full accessibility scans, including color contrast. One pinned Chromium worker
exercises Light/Dark at 320/390/768/1440 using this final artifact's CSS/fonts.
All six dialog states have a Close button at least 44 by 44 pixels entirely
inside both viewport and dialog. It verifies the 896px dossier maximum, phone
fit, real nested Practice Escape/locks, menu-first then parent Escape, held
pending cancellation, 503/Retry, real ready editor, explicit notes focus and
Library opener return. Ordinary editor default focus remains Close.
All 200 GETs and 16 read-only preview POSTs are recorded; preview bodies and
synthetic owner are exact. There are zero mutating requests, unexpected GETs,
invalid previews, external attempts or page errors. Every other non-GET is
rejected, and unknown GETs return a diagnostic 404 rather than generic data.

Current normalized 40-file engine source hash still matches retained engine
1.6.12/bundle `d27b37abb9997712`, with agent 0.24.7 metadata. All five manifest
assets pass SHA256 and byte-size admission; ZIP SHA256 is
`ba357c54c2f3d69b923adc391230dc4382693eabb697b23bf287a665ad1f0858`.
The tracked scrubbed sample keeps its CRLF bytes: raw SHA256
`05e874e4792b9e054021efbe0008a935a4cd1c4e4395b1f3e061508b476f0c40`;
normalized SHA256
`91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`.
Current source/bundle/schema admission and the actual strict sample reader
accept all four payloads. Zero files are copied, overwritten or generated.

Exact final receipts, relative to this worktree:

- `.cache/build-dialogs-close-final-units-result.json` and `-units.log`
- `.cache/build-dialogs-close-final-{types,strict-lint,inherited-lint,ui-rules,ui-ratchet}.log`
- `.cache/build-dialogs-integrated-final-help-generation-fixed.log`
- `.cache/build-dialogs-close-final-asset-admission.json`
- `.cache/build-dialogs-close-final-{build,budgets,postbuild-types,browser}.log`
- `.cache/build-dialogs-close-final-evidence/result.json`, all 48 AA JSONs and PNGs
- `.cache/build-dialogs-close-final-prebuild-owned-sha256.json`

The 19 owned hashes are checked unchanged after the final build and before
proof documentation updates. Only this checkpoint and final proof receipts
change afterward; runtime code, Help, baseline and runner bytes stay frozen.
Root owns review/copy of final synthetic captures to
`docs/handoff/screenshots/build-dialogs-dossier-light-320.png`,
`build-dialogs-editor-dark-320.png` and `build-dialogs-editor-light-1440.png`.
The final-source hash manifest records that documentation boundary separately.

Root independently reviewed the final phone Dossier, phone Dark editor and
desktop Light editor captures. The 320px editor Close is fully visible after
the measured repair. All three new committed copies are byte-identical to the
final evidence PNGs; no old or owner image was overwritten. Root's delivery
hash receipt records subsequent checkpoint-only documentation edits separately
from the frozen runtime sources.

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
conditional trigger restoration remain. Hook autoFocus is disabled to preserve
the menu's ready timing. A ref-backed restore policy resets when opened: Escape
and explicit dialog/replacement actions retain the opener chain, outside pointer
dismissal uses if-lost, and blur/Tab, geometry and ordinary toggles retain their
existing no-restore behavior. The old duplicate document Escape listener is
removed. No shared focus primitive or API changed.

Exactly the two retired dialog-outside-ui allowances for these consumers are
pruned. No replacement allowance or broad baseline regeneration is authored.
Help and changelog describe the user-visible Close/Retry/keyboard behavior.

## Historical initial validation

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

Root preserved the feature at `e42e9649` and normally integrated current
Execution/Try main at `e0fb1819`. An early real-Modal handoff extension then
confirmed a product RED: after replacing a dossier/menu with the editor, closing
the editor focused body rather than the Library opener. The initial menu
restoreFocus:false discarded the opener transferred from its disappearing
parent. The approved ref-backed consumer policy above fixes that chain without
stealing Tab or new-dialog focus. The preserved failing case passes afterward,
and all combined 108 checks/11 suites plus whole types pass again before any
production build. Both original RED and fixed logs/results are retained.

At that initial boundary production/browser validation had not yet run. The
subsequent actual full Library harness retains real Dossier, launcher/rich
editor, Practice, menu and lazy Help rather than relying on mocked shells.
All prior receipts remain historical evidence; only the current final proof
above applies to the delivered source.

## Observed browser failures and approved repairs

The valid all-zero phase DTO exposed an inaccessible horizontal phase scroller:
all five tabs were disabled. Only that all-empty tablist now gets tabIndex 0
and existing focus-visible styling. Counts, disabled states, calculations and
reached-phase roving navigation are preserved; the existing suite covers
empty-to-reached navigation.

The real lazy Practice trigger disappeared before the child Modal captured
its opener. The controller now focuses only its connected enabled replacement
options/quick-fallback trigger immediately before initial dialog opening when
not startOpen. Resume, assignment/auth and shared APIs are untouched. Both
lazy options and quick-without-matchup Escape-return cases pass.

The 503-to-Retry-to-ready editor browser flow then exposed a lost return target.
A new real launcher regression was RED before removing only redundant JSX
autoFocus on the Name field. Shared Modal's existing Close default focus and
explicit notes/preview initialFocus refs remain. The regression and all eight
browser contexts pass after that one-line removal.

Desktop Light editor AA found success add-rule labels at 4.37:1 and Proxy
building at 4.48:1. Only those foregrounds use existing text-text; semantic
backgrounds, borders, hover colors, wording and rule behavior are retained.
The real editor's capped read-only POST preview is explicitly validated and
served a typed empty DTO rather than being misclassified as a write.

The first integrated artifact passed 281 interaction checks and 48 AA scans,
but screenshot review found the 320px ready-editor Close clipped. The new
geometric check measured its right edge at 333.640625px inside a 320px panel,
an observed 13.640625px overflow. That RED is preserved in
`.cache/build-dialogs-close-bounds-before-evidence`. Only Modal's header-copy
flex item changes from space-y-1 to min-w-0 flex-1 space-y-1; no API, title,
other style or focus behavior changes. Its final Close rectangle is x=261,
width=44, right=305 in both 320px themes. The extra production build is
justified by this measured source defect. Prior 281-check artifacts and
prior-CSS diagnostic matrices are explicitly incomplete final visual proof.

Harness startup/module-resolution and typed-DTO repairs, the exact paired-read
arrival wait, test-only unsupported RTL typing corrections, and cache-only Help
path/sample-reader-property mistakes are preserved in earlier logs. They
introduce no production exceptions or weakened AA/privacy/count assertions.
No agent Git mutation, provider/account operation, native/engine edit, real
API write, new dependency or budget change occurred.
