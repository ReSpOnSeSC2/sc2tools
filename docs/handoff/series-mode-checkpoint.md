# Series mode (Wave 4)

Owned branch `codex/wave4-series-mode` in the preserved
`.worktrees/wave3-my-reviews` checkout. The original Ghost, Admin, Rivals,
Strength and Mechanics branches and ignored caches remain intact.

The pure reducer and token-admitted service use a bounded `streamSeries`
subdocument in the existing canonical Studio row. Explicit Start/End and manual
corrections use revision CAS. Accepted real replays require an exact recorded
start after the series start and exact opponent identity; known account
mismatches cannot fall back to names. Ties consume maps without wins. At most
80 hashed receipts remain until a new Start, then automatic scoring pauses.

The replay pipeline's `date` is its end; game-clock duration is not a safe wall
clock subtraction. Missing exact starts therefore remain manual-only. The
accepted-ingest schema requires nonempty string IDs up to the shared
200-character limit, including numeric-looking strings. No private replay IDs,
receipt hashes, account handles or owner/token IDs enter `overlay:series`.

Dock controls, the dedicated Series widget and All-in-one reuse their existing
socket. A strict public DTO and monotonic revisions prevent late bootstrap,
resync and save responses from replacing newer state. Test-fire is display-only.
The widget is off by default. Lifetime H2H is bounded, cached, local and only
available for an exact identity. `!series` extends the shared Chat registry and
cooldown/platform facade, with one projected Studio read and no H2H/provider
lookup on a command.

The shared Dock lazy boundary loads in an effect with a bounded deadline,
local error state and fresh Retry. This prevents React's discarded initial
suspense memo from repeatedly constructing an unmounted lazy identity when
another control island is present. Root reviewed that delta; the unchanged
real Dock profile host and all existing recovery assertions pass.

Preserved source includes actual Moments main b2212bbd and reviewed shared Chat
5e0cfa36. Its squash-order reconciliation retains the exact combined source
tree. Both moment fresh-only scoring and Series all-accepted-row scoring remain.
The final combined pure/service/route/socket/Chat/Moments run passes 148 API
cases across 11 suites; full API/web typechecks pass. Local Dock consumer sweep
passes 164 tests, overlay sweep 706 and final focused web 32, including actual
dedicated/AIO Series transport 4 and shared Chat 15. The sample widget image and
87-article generated Help index are current.

The standalone local browser harness passes 145 checks with eight production-font
light/dark captures at 320/390/768/1440. It covers default-off displays, explicit
Start, exact scoring, ties/duplicate/mismatched account rejection, held older
events, sample/real isolation, manual completion/correction, held map-pool draft
protection and default-Cancel keyboard End. There are no page errors, external
requests or horizontal overflow. Captures live under `screenshots/series-mode-*`;
rerun from `apps/web` with `node tests/manual/series-mode.mjs`. Root reviewed the
pure model/service and focused Dock loader delta. Independent final review of
the controls, DTO, widget/sample layers, token/revision/CAS fences and light
320/dark 1440 captures found no blocker.

Required engine build/smoke passes f96c086eb83fdc40 (223 files / 79 pyc).
Production Next build and every unchanged budget pass: landing 214.8/215,
Today 238.9/240, Dock 215.1/225, AIO 238.2/240, dedicated widget 322.7/325 and
guide 169.1/175 kB. Native source-size/OBS layout compatibility passes 86
offscreen tests. The 32-entry size catalog asserts Series 640×420 explicitly.

PR #737 first-head full web passed 7,543 tests and failed only two stale widget
counts. The real lightweight product fact now advertises 32; the manager fixture
asserts 32 cards and an explicitly disabled Series switch. The 12 focused
manager/product/page tests pass. Exact-head GitHub/Vercel and the shared Chat
#733 dependency remain final merge gates.

No actual account/provider/OBS operation, production job/migration,
infrastructure or budget increase, release/version action or AI/model call was
performed.
