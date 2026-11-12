# ADR0051: Recorded SC2 moments on the existing alert path

Status: Accepted

Moment computation runs once for each newly inserted, freshly ended competitive
game. A batch sends the latest fresh game to the overlay and can send a private
bell milestone for each qualifying replay. Historical imports, resumed replays,
hidden or deleted rows, and repeat ingestions cannot create a moment receipt. A
conditional receipt on the existing owner/game row deduplicates processing;
no new collection, index, background poll or upstream provider call is added.
An owner mutation lease protects the receipt and delivery from erasure and
visibility controls. When only stream alerts are enabled, the receipt is
claimed inside exact token write admission. Opted-in players can claim the
same receipt without an overlay token.

One bounded slim history read supplies recorded context. Comparative ladder
facts use the exact owner account and ladder race, with the same region guard
as ticker facts. A cached regional season boundary and complete time coverage
are required for a season-peak claim. Missing or truncated evidence suppresses
the claim rather than inventing a baseline. Replay MMR is a game-start rating,
so copy says **Recorded MMR** and never attributes that rating change to the
current game's win. Giant-killer comparisons require replay rating provenance
on both players. Estimated MMR-derived leagues never establish a promotion;
the first actual Pulse league snapshot is only a baseline.

The computation records all derived kinds on one receipt and each delivery
filters them using its own settings. Nine known moment kinds share a closed
preference shape under the existing multichat alert settings. All are opt-in,
silent and without bot posts by default. MMR milestone spacing is 100 or 250,
with a 100 MMR step when no overlay configuration is loaded. Visuals and
sounds reuse the existing allowlisted catalogs. Settings use the existing dirty draft/Save
flow; a local Test does not save, enable an integration or post a message.

`overlay:moment` is carried by the sources' existing socket. The alert widget
labels it **Ladder** and schedules it behind supporter events, particularly
subscriptions and raids. The existing clip log records the moment. Optional
bot delivery uses its existing bounded queue and exact token/connection guards;
it never creates or enables a provider connection. Game-widget pause suppresses
ladder alerts while ordinary chat/supporter alerts remain usable.

Any player can opt in to **Milestones** in their notification preferences.
The private bell supports recorded MMR marks, season peaks, win streaks,
broken loss streaks, revenge wins, giant-killer wins and marathon wins.
Pulse league changes and approved streamer-opponent wins use stream delivery.
Giant-killer copy rounds the replay rating gap to the nearest 100 MMR.
The bell respects per-kind mutes and uses the existing per-recipient delivery
key with the game ID and moment kind. Server delivery ends at the bell.
The receipt stores pending bell items before delivery. A failed write gets one
immediate retry. A fresh, accepted reupload can finish pending bell delivery
under the same event keys, with current preferences and without replaying the
overlay.

The desktop Agent has a separate opt-in for showing the newest unread
milestone of a freshly synced game. It reads the private bell with the device
credential, gives sequential bell writes a short settling interval, and holds
the notice during play. A local owner-and-game receipt is saved before native
dispatch so restarts cannot repeat the same notice.
