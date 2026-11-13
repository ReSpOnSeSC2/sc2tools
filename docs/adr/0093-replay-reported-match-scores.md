# 0093 · Replay-reported match scores

## Decision

A player opens a seat link and explicitly chooses one replay. The browser starts the existing replay worker only then, with the refresh policy disabled. The header must describe a finished one-on-one game between distinct human players. Player names are shown only in the local selection dialog. The pinned header protocol omits observers and does not identify the recorder.

The browser derives a room-scoped SHA-256 digest for each toon handle. The first report binds the pair in seat order. The receipt hashes the sorted digests, canonical map key, replay end time and duration. The API recomputes it and checks the ordered binding and winner. A matching report from the other seat marks the result confirmed by both. The API never receives or verifies replay bytes. Two independently recorded files must agree on end time, duration and map to confirm.

New reports advance the existing veto order one game at a time. They must end after the actual final veto turn and after the last score's known time. A manual entry uses the time it was recorded because it has no replay timestamp. Old rooms without an exact veto time, solo practice and ambiguous custom map labels keep manual scoring. The three existing presets have a fixed veto order.

The host can undo immediately. The two seats can undo by agreement at the current revision. A per-map replay timestamp prevents an undone game from being added back. Undoing every replay result also clears the seat binding. Match Rooms retain their existing expiry and CAS semantics. Receipts, toon digests and raw timestamps stay out of every room response. They expire with the room.
