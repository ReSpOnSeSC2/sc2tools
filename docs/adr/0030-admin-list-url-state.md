# Admin list URLs and shared table semantics

Complete `admin-polish-4` with one typed query-state hook, cursor helper and
shared table. The URL remains authoritative through refresh and Back/Forward;
default values are omitted, unrelated parameters survive, filters replace history
and reset pagination, while page/cursor moves push history. Pending debounced
search writes are cancelled after navigation or unmount.

Cursor Previous history exists only in the current session. An externally shared
cursor offers First page instead of inventing a predecessor. Game selections use
existing owner-scoped private endpoints and preserve the global game's owner ID;
unknown games are explicit and can be cleared independently.

Desktop rows use native stretched anchor links and sortable headers. The same
column definitions render phone cards; interactive cells remain above the row
link. Existing data stays rendered while validation dims the table and announces
Updating. A first-load failure takes precedence over skeletons.

Tests exercise real SWR/fetch search requests and retention, actual game-page
selection and unknown IDs, URL coercion/history/unknown parameters, abandoned
search cancellation and cursor restoration. The chart body is a separate tested
boundary in selection tests. No API contract, authorization or data write changes
are required. Later admin game, inbox and dashboard packs remain separate.

Validation: all 262 affected admin/help tests pass, including thirteen new URL, table,
real SWR/fetch and game-selection cases. Full web types and strict changed-file
lint pass. The exact-CI production build passes all unchanged route budgets.
Four actual-component fixtures at 390 and 1440 px verify browser Back after a
search/page move and native stretched links reached from non-title cell centers;
all have zero body overflow, script errors or network calls. Test data stays local.

Review regression coverage also delays the router's own acknowledgement: after
submitting `pla`, an acknowledgement cannot replace the newer draft `player`.
External Back always restores the historical search. Back and the due debounce
are delivered in the same test batch, before navigation effects, and cannot
rewrite that entry. The generic query hook synchronizes refs during render and
checks the browser location/epoch at the timer boundary; the input owns its
300 ms draft debounce and distinguishes its submitted value from newer typing.
The four browser fixtures repeat acknowledgement lag and native history with
actual mounted list components, not a synchronously updating router assumption.
