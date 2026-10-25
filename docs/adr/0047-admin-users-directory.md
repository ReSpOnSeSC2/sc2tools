# ADR0047: Bounded admin Users pages and exports

Status: accepted for implementation (admin-polish-8).

The Users directory and CSV use one server-side matched pipeline. Literal
account filters use countDocuments; game/device-derived filters count the same
post-lookup predicate instead of materializing an unbounded user-ID array.
Games/opponents count sorts group the existing indexed games by userId, join
real accounts and retain zero-game accounts. Revisit at roughly 20,000 users or
when a maintained users.gameStats summary exists. No new scheduler or stored
counter is introduced.

Offset pages cover every supported sort with stable userId ties. The previous
activity cursor is accepted for one release. CSV uses the existing replay CSV
cell escaping primitive, a cursor and a 10,000-row ceiling. One active export
and one request per admin per minute bound load. The audit contains count and
truncation metadata only; the download is private/no-store. Counts and the
truncation flag describe the export-start read; streamed rows can change during
concurrent activity and are not claimed to be a database snapshot. Last activity
in the list/CSV uses the exact sort fallback (replay, sign-in, signup).

The existing Support snapshot stays detail-only. Its lastSeenAt is activity
from authenticated device requests, so the UI does not call it a heartbeat.
Paired-at-least-once list filters retain historical device rows; missing dates
remain unknown. User-scoped notification events match payload.userId and exclude
anonymized rows before pagination; response-only batched identity hydration is
unchanged. The payload.userId/createdAt/eventId index follows the real schema.
Index declarations are not a production migration execution.

All validation uses synthetic local data. Exports contain emails and must stay
internal and be deleted after use. No production data/export/index operation
is part of this change.
