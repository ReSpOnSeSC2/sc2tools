# ADR0054: Explicit, token-owned Series mode

Status: accepted for implementation (`series-mode`, Wave 4).

The Dock starts a best-of-1/3/5/7 series only after an explicit action. Its
bounded `streamSeries` subdocument lives in the existing canonical token-owned
Studio row. Existing rotation, deletion and data inventory handling therefore
carry the state without a new collection, index, job or infrastructure.

Controls use a monotonic revision and compare-and-swap over the Series field.
Unrelated Studio edits remain intact. Every control and ingest mutation joins
the existing token write admission/drain, and a raced unavailable token cannot
prevent another healthy token from scoring. New Start resets that series's
score and receipts; explicit End stops automatic scoring. Manual corrections
preserve receipts and can reopen an accidentally completed score.

Replay identity uses a known toon handle first. A known mismatch never falls
through to a same-name account. Otherwise matching uses an exact name ignoring
case; a typed-name series pins the first matching replay's valid toon. Both
ladder and custom games are eligible. Hidden/deleted/resumed/test rows are not.

The replay pipeline explicitly defines `date` as replay end and supplies
`startedAt` from `replay.start_time`. `durationSec` comes from the game clock,
so subtracting it from end time is unsafe for arbitrary game speeds. Automatic
scoring requires a valid explicit start strictly after the series start. Older
replays without that field stay manual-only. Games crossing the start boundary
do not count just because they ended afterward.

At most 80 hashed game receipts remain until a new explicit Start. Ties consume
a played map without inventing a score. Exhaustion pauses automatic scoring
instead of evicting dedupe history. Completion claims its advisory moment in
the same state write; a repeated or ambiguous ingest cannot repeat that claim.
The moment never reconnects or enables a provider.

`overlay:series` carries only a strict public DTO: score, format, display name,
race icons, maps and played results. Private game IDs, receipt hashes, replay
URLs, account handles and owner/token identifiers stay off that transport.
Lifetime H2H uses a bounded cached local aggregate for an exact identity, with
owner/lifecycle fencing. A name-only or unavailable lookup remains unknown.

The Dock, dedicated widget and All-in-one slot reuse the existing socket and
lazy-control boundaries. Test-fire is an ephemeral client display and never
calls the state writer. `!series` extends the shared Chat v2 command registry
and composer; it does not introduce a second command system. Validation uses
synthetic local fixtures only, with no production provider or account action.
