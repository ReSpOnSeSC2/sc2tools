# Series mode (Wave 4)

Owned branch `codex/wave4-series-mode` in the preserved
`.worktrees/wave3-my-reviews` checkout. The original Ghost, Admin, Rivals,
Strength and Mechanics branches and ignored caches remain intact.

The pure reducer and token-admitted service use a bounded `streamSeries`
subdocument in the existing canonical Studio row. Explicit Start/End and manual
corrections use revision CAS. Accepted real replays require an exact recorded
start after the series start and exact opponent identity; known account
mismatches cannot fall back to names. Ties consume maps without wins. At most
80 hashed receipts remain until a new Start, then auto scoring pauses.

The replay pipeline's `date` is its end; game-clock duration is not a safe wall
clock subtraction. Missing exact starts therefore remain manual-only. The
accepted-ingest schema requires nonempty string IDs up to the shared 200-character
limit, including numeric-looking strings. No private replay IDs, receipt hashes,
account handles or owner/token IDs enter `overlay:series`.

Dock controls, the dedicated Series widget and All-in-one reuse their existing
socket. A strict public DTO and monotonic revisions prevent late bootstrap,
resync and save responses from replacing newer state. Test-fire is display-only.
The widget is off by default. Lifetime H2H is bounded, cached, local and only
available for an exact identity. `!series` extends the shared Chat registry and
cooldown/platform facade, with one projected Studio read and no H2H/provider
lookup on a command.

The shared Dock lazy boundary now loads in an effect with a bounded deadline,
local error state and fresh Retry. This prevents React's discarded initial
suspense memo from repeatedly constructing an unmounted lazy identity when
another control island is present. Root reviewed that delta; the unchanged
real Dock profile host and all existing recovery assertions pass.

Preserved source includes actual Moments main b2212bbd and reviewed shared Chat
3e932f72. Both moment fresh-only scoring and Series all-accepted-row scoring are
retained. Pure/service/route/socket and shared command tests pass92 API cases;
full API/web typechecks pass. Local Dock consumer sweep passes164 tests,
overlay sweep706, actual dedicated/AIO Series transport4, and shared Chat15.
The actual sample widget image and87-article generated Help index are current.

Responsive browser proof, required engine/production build and unchanged bundle
budgets remain final local gates. Exact-head GitHub/Vercel and independent
source/visual review remain PR gates. No actual account/provider/OBS operation,
production job/migration, infrastructure or budget increase, release/version
action or AI/model call was performed.
