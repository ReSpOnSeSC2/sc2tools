# Guided tours — local validation checkpoint

2026-10-26 · `codex/wave5-guided-tours` · isolated checkout
`C:\Users\jay19\.codex\worktrees\wave5-guided-tours\SC2TOOLS`.
Validated product head: `17c229bb35e82f3b81749cbcc77cf0768f940626`;
tree: `8562d8efc5aca07ef035f65cf058e6a38d62f56b`.
Original source base: `aa03e6ccfb1d3311008e9b8e1eb954e1a925c8f0`.

This checkpoint records local product proof, the own production artifact and
root visual review. Fresh-main integration and exact-head CI had not run at this
stage. The historical failures and narrower evidence limits remain below.

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
- At source freeze, syntax, types, strict lint, selected units/API, production
  build, unchanged budgets, browser discovery/run, AA, screenshots and CI were UNRUN.
  No completion, release, deployment or visual approval is claimed.

Before bytes and authored drafts are preserved under `C:\SC2TOOLS\.cache` in the
`guided-tours-*-before-*`, `tours-source-draft-94635e73` and source receipt folders.
All isolated source copies were static host writes with immediate raw hash checks.
The reviewed Activation/Settings checkouts and their old evidence were not edited
by this feature; their earlier results are not relabeled as Tours proof.
## Independent review corrections at source freeze

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
That source-only review established no validation runtime, Git commit, native
fullscreen timing, browser or visual success. Its 70 web, 11 added API and 12
browser case counts were declarations, not passing results.

## Integrated static validation at 2d72ee29

At `2d72ee29`, whole-web and whole-API typechecks exited 0 with no diagnostics.
Strict lint of the 42 changed web paths exited 1 with zero errors and two
warnings: the existing BuildCheckInCard autofocus and a new fixture useMemo
dependency warning. The autofocus warning was a baseline candidate; comparison
against main had not run at that stage. The fixture correction derived its query
from the subscribed pathname/search snapshot inside the existing memo. Its
assertions were unchanged; validation of that correction was then UNRUN.

Raw outcomes are in `.cache/guided-tours-validation-2d72ee29/stage1-outcome.json`.
The first driver's console-host closure RED is preserved; root independently
confirmed all four recorded PIDs absent, then reviewed the narrow console-host
and JSON date-string wrapper repairs. Later probes confirmed retirement of all
observed stage identities with no owned listeners. All 47 owned raw files, six
protected seeds and three generated-input absences retained their guarded state.
At that stage, API strict lint, baseline comparison, 131 selected web cases,
24 Foundation cases, build, browser and CI were UNRUN.

## API test grouping at 0e74f1b0

At `0e74f1b0`, strict web42 reported zero errors and only the existing autofocus
warning. The exact main `a0681fd` card produced the same rule, message, node and
attribute; both raw exits remain 1. Root admitted that inherited debt without a
strict-clean claim. API strict3 then exited 1 with zero errors and nine function-
length warnings, including the new Tours describe block. Both groups retained
all guarded inputs and completed independent process/listener closure.

The Tours tests now register through three named functions inside the original
Foundation scope, called within the unchanged Tours describe/hook scope. Their
code lengths are 40, 34 and 39 lines. All test bodies, titles, tables, assertions
and hook bytes are retained; the 11 Tours and 24 total Foundation cases are
unchanged. At that stage, the grouping correction and the three prepared main-
version API stdin comparisons were UNRUN. No function-length suppression or test
removal was added. Raw API evidence is in
`.cache/guided-tours-validation-0e74f1b0/03-api-lint/OUTCOME.json`.

## API static comparison at 10530d28

Candidate API strict3 exited 1 with zero errors and eight existing warning owners;
the new Tours describe warning was gone. Three exact main `a0681fd` stdin
baselines also exited 1, with zero errors and 2/3/3 warnings. All eight owners,
rules and node kinds matched: six messages were identical; existing container
sizes were Foundation 390/258 and buildMeRouter 703/702 (candidate/baseline).
Root admitted only that existing debt, without suppression or a strict-clean
claim. Raw comparison is
`.cache/guided-tours-validation-10530d28/api-warning-comparison.json`, SHA256
`2865d89151f02d5872c1b93a880e6e82dc3788fa2c3342109e6203be27e2cac1`.
Every stage retained all 100 pre/post inputs, 47 owned files, six seeds and three
generated absences. Independent DateKind String/Time6 closure retired 20 raw
identity entries across 16 distinct PIDs, with zero owned listeners.

## Real target fixture provider — first failure retained

At `10530d28`, the selected web group completed 131 cases in 12 files:
130 passed, one Today target-owner assertion failed, and none were pending.
The fixture mounted real DailyPulse without its required AnalysisGamesProvider;
SectionBoundary therefore rendered its fallback instead of the real strip.
The fixture now uses the actual provider inside its existing FiltersContext.
The provider defaults to dormant (`enabled=false`); no target/context mock,
selector weakening, test or assertion change was added. That first group stopped
before Foundation. At `17c229bb`, the one-file strict check had zero errors or
warnings, all eight target-owner cases passed, then all 24 Foundation cases
passed against pinned MongoDB 7.0.14 with runtime downloads disabled. The whole
131-case group was not repeated; this is not a fresh 131/131 claim. The 130
previously passing cases and their original source association stay recorded.

Raw first failure is preserved under
`.cache/guided-tours-units-10530d28/01-web-units/OUTCOME.json`.
All 100 pre/post inputs, 47 owned files, six seeds and three generated absences
matched. Independent Time6 closure retired all 17 recorded identities with no
owned listeners. PID 14696 had been reused by a later unrelated conhost, so the
receipt preserves that match and does not claim all bare PIDs were absent.

## Own build and focused proof at 17c229bb

The focused repair receipt is
`.cache/guided-tours-focused-17c229bb/COMBINED-RECEIPT.json`, SHA256
`0d8044b4a28450f0f9fa0ffba4ed81c7d825758a9f2dcfbdf87a81ca5009cb37`.
It records only the target file's strict check and eight cases, followed by
24 Foundation cases. Earlier whole-web/API types at `2d72ee29` and inherited
web42/API3 lint comparisons keep their original heads and raw nonzero exits.
No inherited autofocus or function-length warning was suppressed or called a
strict-clean result. No whole 131-case rerun was performed.

A genuine own Next build at `17c229bb` generated 148 pages with BUILD_ID
`l2_jI0nYOkCV55KImfv3S`, four CSS files and three local fonts. All 81 unchanged
route budgets passed (18 listed, 63 default), and fresh post-build whole-web
types exited 0 with no diagnostics. The nine established dummy/local flags
were retained; inherited NODE_ENV/NODE_OPTIONS were removed, Next selected its
build mode, and CIRCLE_NODE_TOTAL=2 selected one worker. No npm prebuild, engine
or sample generation, install or download ran. All 40 canonical engine sources,
seven active assets and four existing sample records matched; pre/post own asset
proofs were byte-identical. The 196 raw Next warning lines remain preserved;
no warning-free build or new full warning comparison is claimed.

Build receipt: `.cache/guided-tours-own-build-17c229bb/COMBINED-RECEIPT.json`,
SHA256 `16a546dac48881de4812de1d2a307fc996c17219d004b5f66c329beb14cbcc66`.
All 172 source/runtime pins, 47 owned files and six protected seed rows stayed
unchanged through the five build stages. Recorded processes and owned listeners
closed, including independent retirement checks for the closure observers.

## Browser run, first metadata RED and retained-data correction

Actual discovery selected exactly 12 unique cases in one project. The original
browser matrix ran once using full Chrome 1228, one worker, zero retries,
maxFailures=1, CI=1 and actual removal of A11Y_COLLECT_ONLY. All 12 cases passed
in 46.8 seconds, with zero failed, skipped or flaky cases. It retained 36 shared
AA attachments/audits, 12 transport ledgers, 12 trace archives and 18 explicit
PNG captures. Reported serious/critical issues for the existing WCAG tags were
zero; 22 scans retained incomplete color-contrast observations. This is not full
accessibility certification or a claim that every contrast node was resolved.

Ledgers contain 64 synthetic reads and 42 exact writes: 30 responses were 200 and
12 were intentional save-retry 503s. Errors, unknown/rejected/external/native
attempts and aborted responses were zero. All 12 fixture servers/sockets closed.
The 70 raw RUN identity records represent 69 distinct Time6 identities; all
retired with no owned listeners. Earlier LIST PID 33084 reuse by an unrelated
dllhost is retained honestly; its console identity had retired.

The first browser metadata driver exited 1 despite the browser child exiting 0.
Its expected CSS omitted two LF bytes between font-face definitions, and it
incorrectly required a JavaScript body that ordinary non-live Playwright traces
intentionally omit. The original RED receipt and all raw artifacts remain:
`.cache/guided-tours-browser-17c229bb/02-run/COMBINED-RECEIPT.json`, SHA256
`8bf93c49823440edbbc33309b627aa360e7b0379e626a57467e93ecabb71d2cd`.

Root admitted a metadata-only interpretation correction. One PowerShell reader
reinspection exited 0 with no validation errors, without rerunning Node, browser,
tests or build. All 12 CSS bodies matched the exact own construction: 150228
bytes, SHA256 `42af813a877446da27a00c6b578e4d624a4c2992dc9fe7e3801d33a9bc018bc7`.
All 12 JavaScript GET responses had status 200, script type, JavaScript MIME and
headers; body references were intentionally absent under pinned Playwright
1.61.1 non-live trace policy. **No raw JavaScript response body/hash provenance
is claimed.** Observed Hanken and Bricolage font responses matched their pins;
three fonts were admitted, but only those two were observed fetched.

Original case results, ordered attachments, AA/incomplete data, transport,
audits and PNG records remained deep-equal. All 89 original-evidence/source pins,
11 reader-proposal pins and the original 230/172 source/artifact guards passed
before and after reinspection. Its host and closure observer retired with no
owned listeners. Corrected-evidence receipt:
`.cache/guided-tours-browser-reader-repair-17c229bb/execution/COMBINED-RECEIPT.json`,
SHA256 `c83c538ae95c70937450b88d40d3743f5a836cf92a2de85a050e1acc021363d3`.

## Visual scope and selected captures

Root viewed and approved all 18 original captures for placement, readability,
focus and error panels within the declared synthetic-frame scope. The browser
uses real Tour/controller/Help/Modal/check-in controls, current source and the
own production CSS/fonts, with synthetic target frames and owner transport.
Actual consumer target ownership is separately covered by the eight passing
unit cases. This is not full consumer-page, production API or native fullscreen
transition proof. All 18 original captures and all traces remain in the cache;
eight raw, unedited captures are selected for the repository:

| Surface | View | Capture |
|---|---|---|
| Today | Light, 390px | [Open](../screenshots/guided-tours-today-light-390-open.png) |
| Today | Dark, 1280px | [Open](../screenshots/guided-tours-today-dark-1280-open.png) |
| Game | Light, 1280px | [Open](../screenshots/guided-tours-game-light-1280-open.png) |
| Game | Dark, 390px | [Open](../screenshots/guided-tours-game-dark-390-open.png) |
| Overlay | Light, 390px | [Open](../screenshots/guided-tours-overlay-light-390-open.png) |
| Overlay | Dark, 1280px | [Open](../screenshots/guided-tours-overlay-dark-1280-open.png) |
| Game | Light, 390px | [Save error](../screenshots/guided-tours-game-light-390-save-error.png) |
| Overlay | Dark, 390px | [Save error](../screenshots/guided-tours-overlay-dark-390-save-error.png) |

## Integration boundary

This delivery adds documentation and raw captures to the validated product;
component code, CSS, Help articles and the generated 95-article index are unchanged.
The own `17c229bb` build and bounded proofs are not relabeled as results for a
later documentation or integration commit. Fresh-main integration must preserve
incoming Device pairing lifecycle fixtures alongside all 11 Tours cases in
Foundation, and retain both engineering/changelog explanations. Integrated
exact-head CI remains required. No local build/test repeat, release, deployment,
agent tag/version bump, migration, provider activation or production write is
claimed by this checkpoint.
