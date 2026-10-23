# Admin operations

This covers the existing account repair tools. Later operations-console controls
will extend these procedures.

## Identify the account

Open Admin → Users and verify the account's internal user ID, Clerk ID and recent
activity. The tools accept the internal user ID. Avoid copying an email address
or Clerk ID into an internal-ID field. Record the support issue and the intended
repair before making changes.

## Rebuild opponent counters

Open the user's detail page and choose Rebuild opponents. Read the confirmation,
then run it once and inspect the outcome. This derives opponent counters from
surviving stored games; it does not invent missing games. Refresh the user's
opponents view to verify the corrected counts. Fix my counters in Tools runs the
same repair for the signed-in admin's own account.

## Wipe game history

This permanently removes game history and associated detail/replay storage for
the selected account. Confirm the exact target and the user's intended scope.
The admin wipe is an all-history operation. For a date-limited request, have the
user use Settings → Backups & data → Delete game history with the intended dates;
do not replace a date-limited request with an admin all-history wipe.

Inspect the result before asking the desktop app to re-sync. Wipes record their
scope and bounds in `gdpr_games_wiped`. A database restore must reapply the same
scope; see [Restore database](restore-database.md). Atlas backups do not roll
back deleted R2 objects.

## When a tool fails

Keep the outcome and any Error ID with the support issue. Refresh the account
before retrying an operation whose outcome is uncertain. For a reported-content
decision, the moderation queue explicitly handles an already-resolved report;
see [Moderation](../admin-console.md#moderation).
