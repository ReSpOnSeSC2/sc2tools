# Unified build editor checkpoint

Authorized Wave 4 `unified-build-editor`, including its first-run and Help
augments. ADR0055 records the catalog and request boundaries.

## Scope

- New build opens four starting cards. Replay, detected-label and blank paths
  all use the rich BuildEditorModal. Paste is clearly unavailable until the
  reference-build-order predecessor is implemented. First run also offers
  Copy a Community build at the existing `/community` index.
- Definitions links exact catalog ids to a private variant. Its bounded intent
  and recognized library filters survive sign-in. No write happens on a link
  visit, picker selection or local preview.
- The existing private replay listing supplies 20 rows per cursor page with
  race/opponent/build filters. Only the selected build order is requested.
  Stored effective labels include confirmed check-ins, stated in the picker.
- Owner remounts, render-time source identities, aborts and eight-second read
  deadlines fence held list/detail responses. A projected response validator
  rejects malformed/oversized pages and exposes inline Retry.
- The generated 402-action catalog reuses unit/icon metadata and an explicit
  upgrade/alias list. Friendly names retain exact tokens; race and proxy
  metadata aid selection. Unknown actions remain visible and block preview
  and Save. Shared structural readers and the evaluator remain compatible.
- Combobox keeps focus in its ARIA 1.2 input, supports arrows/Home/End/Enter,
  Escape/Tab/outside dismissal, and bounds visible results to 60. Its fixed
  portal stays inside the real dialog while escaping the rules scroller.
- Optional eager editor consumers now use a local lazy/retry modal. A failed
  chunk cannot take the page down; a fresh lazy identity retries the import.
  Legacy signature/proxy/quantity provenance, locked edit slugs, create-only
  conflicts, private notes, publication and unsaved-close guards are retained.
- Help `custom-builds#create` covers all paths and keyboard behavior. Rules
  retain their legend and lazy worked-example Help link.

## Validation

- 381 affected web/Builds/Definitions/Help/landing/game consumer tests passed
  after fresh-main integration, including the final held-save regression.
  Portalled choices explicitly mirror the
  disabled fieldset while Save is pending, including AX activation that leaves
  focus in the input.
  Includes malformed/held responses, owner/filter ABA, known-token coverage,
  exact canonical storage, legacy signature rows, source-safe saves, modal
  keyboard behavior and rejected-import recovery. Web types and changed-source
  strict lint pass. Generated catalog and 85-article Help index are current.
- Explicit required engine prebuild/smoke passed `f96c086eb83fdc40`: 223 files,
  79 pyc, Python 3.14.2 and a 142,939-byte parse payload. No engine source change.
- Final integrated production Next build passes all unchanged budgets: landing 189.6/215,
  Today 238.2/240, Builds 197.8/270, game 310.5/440, opponent 447.7/500,
  Dock 214.6/225, dedicated widget 318.7/325 kB. Existing unrelated lint warnings
  remain; changed-source lint is strict and clean.
- Real-source browser matrix: 320 checks, 44 captures, ten light/dark contexts
  at 300/320/390/768/1440. Actual Library/creation flow/rich modal/Definitions/
  legacy launcher/replay Save consumer, production CSS/fonts, real SWR/API
  transport, explicit synthetic auth/Next/API data and blocked external traffic.
  Covers picker point hit-testing/44px options, no horizontal overflow, Escape
  and dirty confirmation, keyboard/AX Save with a held response, local-owner/source resets, malformed
  Retry, held selected reads across filter/owner ABA, and chooser axe scans.
- Real Next/webpack public ReplayDemo: nine checks. First editor chunk is
  deliberately aborted, local Retry loads the actual editor/timeline, the same
  failed URL is requested twice and preview selection remains one request.
  Local server/API use only public CI placeholder credentials and synthetic
  preview data. No provider or production operation occurred.

## Review and delivery

Root reviewed the creation/catalog/token/source mechanics and requested the
response validator above. A separate read-only review cleared the validator,
lazy retries, eager caller changes and bounded auth return. Representative
captures are under `docs/handoff/screenshots/unified-build-editor-*.png`.

PR and final CI/merge remain pending at this checkpoint. Preserve incoming
owner work and the actual Moments #735 squash `b2212bbd` on integration. PR #738
includes main `b2f49312` (owner `7ada26b8` plus Ghost #734). The single native
test conflict retained the incoming owner's deterministic assembly barrier
exactly; the reviewed coaching fixture re-exports the real bounded request
helper. The reviewed upload/gate suite passed 76 cases, and all nine gate cases
passed again after retaining the incoming variant. The initial full web CI had
7,543 passing cases and one passive-effect focus timing assertion in the shared
URL-row test; that assertion now waits for focus and full selection, retains
all token masking checks, and its two cases pass. No URL-row runtime code changed.
No migration, new infrastructure, AI, provider activation, account operation,
version bump or release is part of this pack.
