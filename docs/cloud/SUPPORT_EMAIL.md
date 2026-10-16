# Support email in SC2 Tools Messages

Reports submitted by the site's **Report a bug** form are saved through
`POST /v1/messages`. Direct mail sent to `responsecoaching@gmail.com` bypasses
that route. The optional support Gmail bridge imports incoming email into
the same `user_message` admin events, so it appears in **Admin → Notifications
→ Messages**, unread counts, and the live admin feed.

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
3. Set `SUPPORT_GMAIL_MAILBOX=responsecoaching@gmail.com` and explicitly choose
   `SUPPORT_GMAIL_START_AFTER`, an ISO timestamp with timezone. For example,
   `2026-09-01T00:00:00-04:00` imports incoming mail since midnight September 1
   in New York, including already-read or archived reports. Choose the intended
   cutoff; the bridge does not automatically import the entire historical inbox.
   This September 1 cutoff includes the two missed bug reports.
4. Deploy/restart the API. `SUPPORT_GMAIL_INTERVAL_SEC` defaults to 60 seconds
   and has a 60-second minimum. Logs show `support_email_started` when active,
   or `support_email_disabled` when credentials are absent. Incomplete settings
   fail at startup. Confirm the missed report appears under **Messages** and
   opens the original email in the correct Gmail account.

The Notifications page shows whether email import is configured, the last
successful check, or the latest safe failure code. This status refreshes every
minute while the page is open.

Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
describes offline consent and refresh tokens. Ensure the OAuth application's
publishing/test-user settings permit long-lived access; refresh-token revocation
or expiration requires renewed consent.

## Delivery and recovery

The worker verifies the authenticated Gmail profile matches the configured
mailbox before it imports anything. It reads incoming messages using the
[Gmail message listing API](https://developers.google.com/workspace/gmail/api/guides/list-messages),
regardless of read or archive status. Sent mail, drafts, chats, spam, and trash
are excluded. It never sends email or changes Gmail's labels/read state.
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

MongoDB stores a per-mailbox, per-page checkpoint in `support_email_sync`. A
five-minute overlap catches normal Gmail indexing delays, and the unique
`admin_event_unique_ingestion` index prevents duplicate notifications when a
poll, process, or deployment retries. Checkpoints advance only after every
message on a page is saved. An outage does not discard mail merely because
it became read or left the Inbox. First sync and outage recovery process up to
250 messages per poll and continue from the saved page on subsequent polls.

Failures log `support_email_sync_failed` with a safe reason code; OAuth response
bodies, credentials, and email content are never logged. Examples:

- `mailbox_mismatch`: the refresh token belongs to a different Gmail account.
- `oauth_http_400`: refresh token invalid/expired or OAuth client mismatch.
- `gmail_http_403`: enable Gmail API and verify read-only scope/authorization.
- `message_not_saved`: Mongo event persistence failed; the page retries.

Changing `SUPPORT_GMAIL_START_AFTER` does not reset an existing checkpoint. To
intentionally change the historical import window, stop the worker, remove the
mailbox's `support_email_sync` checkpoint, choose a new cutoff, and restart.
Existing message ingestion keys still prevent duplicate events.
