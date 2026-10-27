# Guided tours — source checkpoint

2026-10-26 · `codex/wave5-guided-tours` · isolated checkout
`C:\Users\jay19\.codex\worktrees\wave5-guided-tours\SC2TOOLS`.
Base: `aa03e6ccfb1d3311008e9b8e1eb954e1a925c8f0`;
tree: `73a07ad70609fe3c4170ecc9c8e868d30de10f30`.
Canonical Help generation is complete. Static validation evidence is recorded below.

## Implemented source contract

- One public registry defines Today, Game and Overlay version 1, with four steps
  each, explicit actual target-component owners and a final guide link.
- A light surface loads one controller leaf only after owner/surface admission.
  Today uses its existing admitted games count, Game requires the current matching
  private body, and Overlay uses its current admitted credential lifetime.
- The actual resolved suggestion card owns its target in expanded and compact
  states. Loading or dismissal supplies no fake target. Both card states link to
  the Today tour; Help remains independently available after dismissal.
- Targets must be unique, rendered nodes within the admitted surface. Missing
  steps are skipped; more than half missing prevents startup. The last available
  step still offers the tour's guide without inventing a replacement target.
- Tour controls contain focus, own Escape, restore focus when appropriate and
  use the existing focus-scope stack. Phones under 640px use a bottom sheet;
  reduced motion uses instant scrolling. No hidden pane is automatically opened.
- Every visible BuildCheckInCard content variant is marked. A viewport-intersecting
  card or any visible external dialog suppresses startup. Interruption retires
  without an automatic completion choice or a step-one restart.
- Geometry observation is dormant for a saved current version unless replay is
  explicitly requested. Active work is batched in one frame and retired on cleanup.
- Owner, pathname, record and ready identities retire synchronously across ABA
  transitions. Writes assert them before/after held JWT and decoded response work.
  A malformed or failed ACK keeps an honest retry; no cache mutation or local hide.
- Availability is transient route/record/lifetime-scoped metadata. Full Help and
  another record ignore old failures; old cleanup never clears a newer scope.
- Completion and skip both PUT one known tour version through existing onboarding
  preferences. Mongo merges siblings atomically, retains the maximum valid version,
  treats all input as literal data and returns the same committed projected result.
  Missing or GDPR-fenced owners cannot be upserted or acknowledged as saved.
- Existing goals, What’s new, literal preference fields, independent dismissals and
  the read-only first-game marker remain separate. No reset button or new endpoint.
- Actual Take a tour replay actions appear in its Help widget/article. Only an
  explicit Game replay click resolves the latest owned replay; no private read on
  widget mount. New first-game Help content supplies the canonical final URL.

## Prepared checks at source freeze

- New web suites declare 70 cases: registry 14, Help widget 15, controller 25,
  actual target owners/variants 8 and Tour UI 8. API Foundation adds 11 cases.
  These are source counts, not passing results.
- Legacy five consumer-unit seams retain every assertion/data value and isolate
  unrelated tour behavior. Recovery includes root’s partial actual clientApi repair.
- Formal Settings section/search fixtures model only saved overlay version 1 on
  their exact bounded onboarding GET; previous assertions and ledgers stay intact.
  Scoped manual fixtures use explicit tour boundaries, retaining root’s independent
  first-view bookkeeping boundaries in battle-report and build-execution fixtures.
- The new browser spec declares 12 unique cases: three tours, two themes and
  390/1280 widths. Only desktop runs this explicit matrix in default CI. It uses
  actual controller/Tour/Help/Modal/check-in controls and game sticky navigation on synthetic target
  cards, not full consumer-page layouts. Actual target owners are tested separately.
- Browser source covers incomplete startup, all card/dialog blockers, keyboard,
  motion, error/ACK/restore, missing targets, Help replay, scoped availability and
  held JWT/decoded-body owner/route retirement. It preserves full shared AA rules,
  synthetic transport ledgers and positive owned listener/socket closure.
- The canonical Help generator completed once with exit 0 and 95 articles. Its
  exact two imports/two registry entries were reviewed; all 44 authored bytes stayed
  unchanged. Generated index SHA256 is b9cb04809ce622fa62f79251266b7a21e1ea7560fd3296d60fcfd574b7c90f35.
- Syntax, types, strict lint, selected units/API, production build, all unchanged
  budgets, browser discovery/run, AA, screenshots and remote CI remain UNRUN.
  No completion, release, deployment or visual approval is claimed.

Before bytes and authored drafts are preserved under `C:\SC2TOOLS\.cache` in the
`guided-tours-*-before-*`, `tours-source-draft-94635e73` and source receipt folders.
All isolated source copies were static host writes with immediate raw hash checks.
The reviewed Activation/Settings checkouts and their old evidence were not edited
by this feature; their earlier results are not relabeled as Tours proof.
## Independent review corrections — validation pending

Root reviewed and statically copied eleven exact paths from the preserved cache
proposal, including its stronger test-only revision. The authored scope is now
46 paths plus the canonical generated Help index (47 total); all unaffected
frozen paths and the generated index retained their raw bytes.

- Game navigation targets the actual sticky SectionNav. Removing the short new
  wrapper preserves the existing full-workspace sticky containing block.
- Intersecting targets stay at the reading position. Wholly offscreen targets
  reveal at their start; with a real check-in marker, the reveal is instant and
  guarded. An unsafe endpoint restores window/ancestor scroll before paint and
  retires without focus restoration or completion. The existing browser matrix
  now keeps real compact/confirmed cards adjacent to actual game navigation for
  startup and every Next/Back step; it no longer removes them to admit this proof.
- Fullscreen suppresses startup and immediately aborts an active/pending attempt.
  Exit cannot automatically restart. Regressions cover held preferences and
  held token/decoded-body finishes across entry/exit, fresh Replay and a fresh
  Skip while the old response remains held, and the old answer arriving while
  the fresh ACK is pending. Existing abortable request behavior settles on abort;
  source review found no need to add speculative async retirement machinery.

Before bytes, full proposal and follow-up analysis are under
C:\SC2TOOLS\.cache\guided-tours-checkin-reveal-fix-aa03e6cc and
C:\SC2TOOLS\.cache\guided-tours-root-reviewed-copy-aa03e6cc.
No validation runtime, Git commit, native fullscreen timing, browser or visual
success is established by this source-only review. The 70 web, 11 added API and
12 browser case counts are declarations, not passing results.

## Integrated static validation — fixture correction pending

At `2d72ee29`, whole-web and whole-API typechecks exited 0 with no diagnostics.
Strict lint of the 42 changed web paths exited 1 with zero errors and two
warnings: the existing BuildCheckInCard autofocus and a new fixture useMemo
dependency warning. The autofocus warning is a baseline candidate; comparison
against main has not run. The fixture now derives its query from the subscribed
pathname/search snapshot inside the existing memo. Its assertions are unchanged;
validation of this correction remains UNRUN.

Raw outcomes are in `.cache/guided-tours-validation-2d72ee29/stage1-outcome.json`.
The first driver's console-host closure RED is preserved; root independently
confirmed all four recorded PIDs absent, then reviewed the narrow console-host
and JSON date-string wrapper repairs. Later probes confirmed retirement of all
observed stage identities with no owned listeners. All 47 owned raw files, six
protected seeds and three generated-input absences retained their guarded state.
API strict lint, baseline comparison, 131 selected web cases, 24 Foundation cases,
build, browser and CI remain UNRUN.
