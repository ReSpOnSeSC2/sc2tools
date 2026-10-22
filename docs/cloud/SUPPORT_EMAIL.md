# Support email in SC2 Tools Messages

Reports submitted by the site's **Report a problem** form (Help & support
menu, avatar menu, error screens, Settings → Help) are saved through
`POST /v1/messages`, with their type and any diagnostics the sender kept
ticked. Direct mail sent to `responsecoaching@gmail.com` bypasses
that route. The optional support Gmail bridge imports only incoming email
carrying the exact **SC2Tools Support** Gmail label into the same `user_message`
admin events, so it appears in **Admin → Notifications → Messages**, unread
counts, and the live admin feed. Mail elsewhere in the mailbox is ineligible.

## Enable the bridge

1. Enable the Gmail API in an operator-owned Google Cloud project and create
   an OAuth client. Obtain offline consent while signed in as
   `responsecoaching@gmail.com`, requesting only
   `https://www.googleapis.com/auth/gmail.readonly`. Store the resulting refresh
   token securely. A site's YouTube integration token or the Gmail connector
   connected to a Codex chat does not configure the production API worker.
2. In the API deployment's secret environment settings, set
   `SUPPORT_GMAIL_CLIENT_ID`, `SUPPORT_GMAIL_CLIENT_SECRET`, and
   `SUPPORT_GMAIL_REFRESH_TOKEN`. Do not commit these values.
3. In Gmail, create the custom label **SC2Tools Support** and apply it to the
   support messages you want copied into SC2 Tools. A carefully scoped Gmail
   filter can apply it to future support messages; other incoming mail stays
   outside the admin inbox. The importer itself cannot create labels or filters
   because its credential remains read-only.
   Gmail labels apply to individual messages: future replies do not inherit a
   thread's existing label automatically. Ensure the filter also matches support
   replies, or label each incoming reply. See Google's
   [message/thread label behavior](https://developers.google.com/workspace/gmail/api/guides/labels).
4. Set `SUPPORT_GMAIL_MAILBOX=responsecoaching@gmail.com` and
   `SUPPORT_GMAIL_LABEL=SC2Tools Support`. The label setting defaults to this
   name when omitted. An explicitly blank setting is invalid. Names match
   exactly, including capitalization. If the label does not exist or cannot be
   read, import stops; it never falls back to the mailbox or Inbox.
5. Explicitly choose `SUPPORT_GMAIL_START_AFTER`, an ISO timestamp with timezone.
   For example, `2026-09-01T00:00:00-04:00` admits labeled incoming mail received
   since midnight September 1 in New York, including already-read or archived
   reports. This cutoff includes the two missed bug reports once labeled. Mail
   received before the cutoff remains excluded even if it is labeled later.
6. Deploy/restart the API. `SUPPORT_GMAIL_INTERVAL_SEC` defaults to 60 seconds
   and has a 60-second minimum. Logs show `support_email_started` when active,
   or `support_email_disabled` when credentials are absent. Incomplete settings
   fail at startup. Confirm the missed report appears under **Messages** and
   opens the original email in the correct Gmail account. Confirm unrelated
   unlabeled mail is absent.

The Notifications page shows whether email import is configured, the last
successful check, or the latest safe failure code. This status refreshes every
minute while the page is open.

Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
describes offline consent and refresh tokens. Ensure the OAuth application's
publishing/test-user settings permit long-lived access; refresh-token revocation
or expiration requires renewed consent.

## Delivery and recovery

The worker verifies the authenticated Gmail profile matches the configured
mailbox before it imports anything. It resolves the exact custom label's ID
with the read-only [labels listing API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list)
on each poll. It passes that ID to the
[Gmail message listing API](https://developers.google.com/workspace/gmail/api/guides/list-messages),
and checks the label again on each fetched message before saving. Read or
archive status does not affect eligibility. Sent mail, drafts, chats, spam, and
trash are excluded. It never sends email or changes Gmail's labels/read state.
The cutoff query uses Unix seconds as documented in Google's
[filtering guide](https://developers.google.com/workspace/gmail/api/guides/filtering)
to avoid the API's default timezone for calendar-date queries. Google's
[scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes)
documents the read-only permission.

Imports carry the sender's email header as an external contact, not a verified
SC2 Tools account identity. Plain text is preferred; HTML-only mail is rendered
as plain text. The saved preview is capped at 4,000 characters. Attachment names
are listed, and **Open original email in Gmail** provides the full message and
attachments. Attachments are not downloaded into SC2 Tools.

MongoDB stores a per-mailbox-and-label, per-page checkpoint in
`support_email_sync`. Every completed pass restarts at the fixed configured
historical cutoff on the next poll. This lets an older report become eligible
when the support label is applied later, rather than advancing past its email
date. Each pass processes up to 250 messages per poll and continues from its
saved page on subsequent polls, keeping the upper time boundary fixed until
the pass completes. Checkpoints advance only after every message on a page is
saved.

The unique `admin_event_unique_ingestion` index remains keyed by mailbox and
Gmail message ID. Existing approved copies therefore retain their event ID and
read state when the importer changes from mailbox-wide to label-only intake,
or when the configured label changes. Old mailbox-wide checkpoints are ignored
by the new scoped worker and its admin status. An outage does not discard mail
merely because it became read or left the Inbox.

Failures log `support_email_sync_failed` with a safe reason code; OAuth response
bodies, credentials, and email content are never logged. Examples:

- `mailbox_mismatch`: the refresh token belongs to a different Gmail account.
- `gmail_label_missing`: the exact custom support label is absent; no mail is imported.
- `gmail_labels_invalid` / `gmail_label_invalid`: Gmail returned an invalid label response; no mailbox fallback occurs.
- `oauth_http_400`: refresh token invalid/expired or OAuth client mismatch.
- `gmail_http_403`: enable Gmail API and verify read-only scope/authorization.
- `message_not_saved`: Mongo event persistence failed; the page retries.

Changing `SUPPORT_GMAIL_START_AFTER` does not reset an existing checkpoint. To
intentionally change the historical import window, stop the worker, remove the
mailbox-and-label's `support_email_sync` checkpoint, choose a new cutoff, and
restart. Existing message ingestion keys still prevent duplicate events.

Removing a Gmail label does not automatically delete an already imported admin
copy. The operator cleanup utility can remove unrelated copies from the earlier
mailbox-wide importer after reviewing a dry run. That cleanup affects only
SC2 Tools admin events; Gmail messages and labels remain untouched.

Deploy the label-only importer before cleaning up, so an older process cannot
reimport the removed copies. In the API service's Render Shell (working directory
`apps/api`), run `node scripts/cleanup-support-email.js` for a dry run. The preview
contains only candidate message IDs, sender headers, and subjects. Review it,
then use `node scripts/cleanup-support-email.js --apply` for the authorized
cleanup. From the repository root, use the same commands with
`apps/api/scripts/cleanup-support-email.js`. The utility uses the service's
existing environment secrets, validates the live mailbox and exact support label,
and preserves currently labeled copies. It does not read email bodies or write
to Gmail. Do not paste secrets into the command or print the environment.
