# ADR 0039: Browser-local Dock layout before Game desk

Status: Accepted

The Dock's existing nine panels share a controlled disclosure and pin layout before Game desk changes their data or actions. One keyed grid parent preserves drafts when a panel is pinned, unpinned, collapsed or reset. Hidden panels remain mounted so live state and unsaved inputs survive.

Only bounded known section IDs, pin order and the b-roll manager's open state are saved under `sc2t:dock-layout:v1`. Storage errors fall back to this visit's state. Opening a Dock does not write defaults. Tokens, chat, drafts and stream state are never included in this preference.

Dock controls wrap the existing UI primitives. Fine pointers retain dense 32px controls; coarse pointers have at least 40px targets. Copy actions use a bounded clipboard attempt and expose selected read-only text after rejection, absence or timeout. Explicit labels and visible focus accompany icons.

Collapsed summaries use the same studio state, local poll tally and engagement snapshot as the open panels. Unknown data stays Loading rather than implying a zero. The b-roll editor is loaded only after its disclosure is opened and stays mounted after that to preserve its draft.

The subsequent `live-scouting-brief` predecessor supplies the token-authenticated Scout panel through an explicit public projection. The private analyzer dossier brief remains separate. Game desk preserves that projection and the shared active-only live/session socket contract.

Game desk places the independent counts-only `DockPresenceStrip` inside its sticky status header. Header height is measured so jump targets and scroll-spy retain the correct offset at narrow widths. A separately loaded Game panel keeps optional controls out of the initial Dock bundle and uses the same local retry boundary.

Optional build picking, b-roll management and graph previews each have a local import/render boundary. A load has a 20-second deadline; explicit Retry creates a fresh lazy identity and invokes the import factory again. An unavailable optional chunk cannot unmount the other panels or their drafts.

Game desk stores its strict boolean pause on the existing Studio document. Existing overlay sockets replay that state; game widgets and scouting voice wait for it on a cold source and after resync, without adding sockets or polling. Chat, scenes and other production controls remain usable. Approved opponent channels use bounded exact identity reads with no seed/import/provider/name resolution; directory mutations fence cached and in-flight results.

Verified prediction settlement uses a durable per-token lane and monotonic sequence on the canonical Studio row. The current lane drains before another sequence can start. A single scalar receipt per viewer makes score increments resumable and idempotent without an unbounded ledger or per-chat writes. Existing engagement summary reads resume a pending lane after a restart through one bounded indexed metadata read. Cancel/manual/verified outcomes compete for the same prediction claim; manual and cancelled rounds never enter oracle scores or accuracy. Verified reveal sequences and the durable summary cursor reject late older delivery in the widget and bot.

Session reset writes a monotonic account anchor and advances the token's stream-start mark from the committed anchor. The session resolver applies that lower bound, discards held pre-reset computations, and includes the anchor in its DTO so clients reject late older fanouts. No collection, index, migration, environment variable, or external activation is introduced.
