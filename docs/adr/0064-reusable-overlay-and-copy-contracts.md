# ADR 0064: Reusable overlay and copy contracts

Status: accepted for implementation, 2026-10-25.

The first `ui-primitives-and-dialogs` pack establishes reusable contracts before
migrating existing consumers. Existing controlled Review confirmations and the
Devices typed `UNPAIR` flow keep their current approval requirements.

`Sheet` wraps `Modal` with an explicit `bottom` or `right` placement at every
viewport. Modal's default `responsive` placement preserves its existing mobile
sheet/centered card and desktop center/side behavior. Sheets reuse Modal's
reference-counted body scroll lock, accessible title, footer and focus handling.

`Popover` is a controlled, named nonmodal dialog. Its trigger owns
`aria-expanded`/`aria-controls`. It does not lock body scrolling or trap Tab.
Escape closes the top dismissal layer; Tab belongs to the top trapping scope.
Registered nonmodal descendants remain in that modal's logical Tab domain even
when their portal host is physically outside or before the modal. Unknown custom
dialogs retain their own keyboard behavior. Named radio groups retain one Tab
stop and native arrow selection; closed details expose their first summary and
exclude their hidden body controls.

An optional `autoFocus={false}` lets a lazy consumer retain its own ready-and-
merged focus timing. Default portals stay inside the enclosing dialog or use
the document body. Positioning clamps to the viewport, caps oversized content
and flips above the trigger when appropriate. Outside pointer dismissal waits
for native focus: a clicked button/input keeps focus, while body or registered
dialog-root fallback returns to the trigger. Return targets are transferred
when a parent and its portalled child unmount together. Restoration is fenced
against reopening and a newer trapping scope.

React overlay ownership also supplies visual layers across portals: root
Modal/Popover use 50, nested overlays add one and cap at 59, below Toast's 60.
A custom portal host must permit normal stacking; a constrained ancestor CSS
stacking context cannot be escaped by a higher descendant z-index.

`IconButton` requires an accessible label and has a minimum 44px target.
`SkeletonChart` and `SkeletonKpi` expose one loading announcement and decorative
shapes without invented numeric results. Existing LinkButton and other skeleton
primitives are reused.

`useConfirm(scopeKey)` returns `{ confirm, cancel, dialog }`. Render the local
controlled `dialog` once and keep the actual asynchronous operation with its
caller. One request may be pending; a concurrent request resolves false.
Cancel, scrim, Escape, scope change and unmount resolve false; explicit approval
alone resolves true. Captured callbacks and old dialog handlers cannot act on a
successor scope, including an A→B→A return. This boolean API does not replace
typed destructive confirmation.

`useCopy` writes only after explicit activation. `CopyButton` provides its
accessible UI, optional Toast, pending/success status and a visible selected
readonly input or multiline textarea when clipboard access is missing, denied,
restricted or stalled. Clipboard permission has a five-second deadline;
superseding, clearing, scope changes and unmount retire stale delivery. Native
prompt and hidden `execCommand` fallbacks are not used.

The shared horizontal notification placement calculation is a lightweight leaf
module, reexported from its previous location. Generic Popover does not import
NotificationBell's authentication, socket or data dependencies. NotificationBell
itself is not migrated in this pack.
