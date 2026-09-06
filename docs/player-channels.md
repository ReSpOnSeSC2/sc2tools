# Shared player channels

Player Twitch/YouTube channel links live in the global MongoDB `player_channels` collection. They are resolved at read time, so editing one directory entry updates the player's opponent profile and opponent-list links across accounts without rewriting historical games.

Generic channel links appear at the top of an opponent's profile and in the opponent list. Individual replay rows, All games rows, and game analysis views show Twitch/YouTube buttons only when a matching recording is available; those buttons open the recording at the game's timestamp. This applies to desktop, mobile, signed-in views, and shared replay views. A connected channel alone does not produce a per-game button.

## Using the feature

- Account settings → Profile → Twitch & YouTube: select saved SC2Pulse/toon identities and submit channel URLs. New submissions and changes require admin review. Existing approved links remain public while replacements await review. Owners can disconnect immediately, including after removing their saved profile IDs.
- Admin → Player channels: search by name, channel, character ID, or toon; add players, review submissions, edit channels and aliases, remove or restore entries, and import the current SC2Pulse directory. A player need not have a SC2 Tools account or a SC2Pulse profile: a complete toon handle is sufficient.
- Removing an admin entry leaves a tombstone so later imports and application restarts do not republish its links. Restoring is explicit in the editor.

The review step is necessary because existing saved SC2Pulse IDs are editable profile settings, not proof of Battle.net or channel ownership. Account linking submits public URLs; it does not request provider passwords or reuse private OAuth tokens. Imported and admin-entered entries are public immediately.

## Data and identity

The shipped snapshot contains 1,243 actual SC2Pulse players with channel links. Fourteen curated records add or canonicalize channels and provide 152 exact character/toon mappings. Together they seed 1,245 distinct players, including Calyx, BerryCruncH, Heaven, ReSpOnSe, and Cubano. Calyx's account association was identified by the user and verified against the exact player in their live opponent history and saved replay identity; BerryCruncH, Heaven, and ReSpOnSe use SC2Pulse's established pro identities. ReSpOnSe's YouTube channel was also confirmed against his own connected channel settings. Cubano's registered account was matched to his exact Pulse identity using a recorded game with the same opponent, map, outcome, and timestamp within two seconds; his official Twitch page links the seeded YouTube channel. See [seed sources](player-channels-sources.md) for provenance, verification date, creator URLs, and exact identities. No example records are inserted into the directory.

On first directory use, the service inserts the snapshot with insert-only MongoDB updates, then applies curated additions. No live crawl is required to bootstrap it. Admin imports refresh the public SC2Pulse roster in bounded batches. Manual edits, self submissions, and removals survive refreshes; curated YouTube overrides preserve the verified canonical channel while imported Twitch links can refresh.

Identity matching uses Pulse character IDs, Battle.net toon handles, and SC2Pulse account/pro relationships. Display names are never join keys. Conflicting identities produce no channel match. Unreviewed new identities cannot inherit a previously approved channel. Shared replay responses contain matched recordings and do not expose the generic channel directory or its ownership and review metadata.

## API

| Route | Purpose |
| --- | --- |
| `POST /v1/player-channels/resolve` | Public, rate-limited lookup of at most 200 stable identities |
| `GET /v1/me/player-channels` | Current user's saved identities and relevant directory entries |
| `PUT /v1/me/player-channels` | Submit channel changes or disconnect an owned entry |
| `GET /v1/admin/player-channels` | Searchable, paginated administration directory |
| `POST /v1/admin/player-channels` | Create a player entry |
| `PUT /v1/admin/player-channels/:id` | Edit, approve, or restore an entry |
| `DELETE /v1/admin/player-channels/:id` | Remove public channels and preserve an import tombstone |
| `POST /v1/admin/player-channels/import-pulse` | Refresh public upstream channel data |

Opponent profiles and the opponent list resolve generic channels through the directory lookup endpoint. Approved directory channels also help the game recording service discover archives for both players using their exact identities. The existing cached provider lookup checks channel ownership and the game's time window, returning only matching recording URLs with timestamp offsets. The signed-in player's private recording preferences take precedence, and removed directory entries suppress the direct SC2Pulse social-link fallback. Provider or directory failures leave the game view usable without recordings. Generic channel URLs are not attached to individual games or replay rows.

## Release and validation

Deploy the API and web changes together using the repository's normal release process. The normal database connection setup creates the directory and identity indexes; there is no separate destructive migration or credential configuration. The live production database is populated only when the deployed service first uses the directory.

Tests cover real MongoDB persistence, the entire shipped seed snapshot, alias/tuple matching, channel URL validation, protected writes, review/withdrawal behavior, imports/removals, public replay privacy, opponent channel rendering, and timestamped recording buttons on desktop/mobile replay rows. Replay rows with only a connected channel display no recording button. Test fixtures are isolated from the production bootstrap data.
