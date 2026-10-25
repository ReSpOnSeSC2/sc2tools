# ADR 0039: Browser-local Dock layout before Game desk

Status: Accepted

The Dock's existing nine panels share a controlled disclosure and pin layout before Game desk changes their data or actions. One keyed grid parent preserves drafts when a panel is pinned, unpinned, collapsed or reset. Hidden panels remain mounted so live state and unsaved inputs survive.

Only bounded known section IDs, pin order and the b-roll manager's open state are saved under `sc2t:dock-layout:v1`. Storage errors fall back to this visit's state. Opening a Dock does not write defaults. Tokens, chat, drafts and stream state are never included in this preference.

Dock controls wrap the existing UI primitives. Fine pointers retain dense 32px controls; coarse pointers have at least 40px targets. Copy actions use a bounded clipboard attempt and expose selected read-only text after rejection, absence or timeout. Explicit labels and visible focus accompany icons.

Collapsed summaries use the same studio state, local poll tally and engagement snapshot as the open panels. Unknown data stays Loading rather than implying a zero. The b-roll editor is loaded only after its disclosure is opened and stays mounted after that to preserve its draft.

The plan's Scout migration remains pending the `live-scouting-brief` predecessor: no token-authenticated Scout panel exists in the current source. The private analyzer dossier brief is not an appropriate replacement. Game desk's Scout work must follow that predecessor; this foundation changes only the existing panels.

The separately owned counts-only `DockPresenceStrip` remains independent and will move into the future status header when Game desk is implemented.
