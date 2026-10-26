# ADR0052: Return to public context after authentication

Status: accepted for `auth-return-to-context`.

`safeReturnPath` accepts only bounded same-origin relative paths under the
public/action allowlist. It rejects fragments, whitespace, absolute/protocol
relative URLs, path traversal and hidden separators. Settings allows only the
Overlay or Profile tab. The existing narrow `/try?resume=1` claim hand-off
remains compatible. Auth helpers and public navigation share this validator.

Both Clerk forms always receive a validated force destination, including when
the incoming value was rejected. Cross-form force destinations preserve the
same policy: sign-in returns directly; new accounts go through
`/welcome?next=...`, except the existing direct Try claim. This follows Clerk's
[documented force redirect precedence](https://clerk.com/docs/guides/development/customize-redirect-urls).
Only the auth link reads search parameters inside its own Suspense boundary;
surrounding public navigation retains static rendering and a usable fallback.

The welcome wizard displays a stable, non-personal return-page label. Skip and
Done use the validated destination. Readiness, owner and continuation epochs
fence delayed JWT/body/cache/navigation work, including A-to-B-to-A changes.

An explicit signed-out Save, vote or public Practice action can store one
bounded intent in sessionStorage for fifteen minutes. Storage contains no
credential or private replay/reference identifier. Validation runs again on
read. Only the matching original path, kind and public build may claim it;
claiming removes it synchronously before asynchronous work. A microtask keeps
StrictMode replay from consuming an abandoned effect. Owner/path object epochs
and a twenty-second deadline fence token acquisition and late responses.
Responsive copies share bounded in-flight admission/busy state. A hidden copy
cannot resume while the visible copy starts a competing manual action.

Resumption invokes the existing actions. Votes set the desired value instead
of toggling an already-correct vote off. Saving first checks for an existing
copy and validates the current public snapshot; a failed lookup cannot create
a duplicate. Public Practice retains its original public target/rules, uses
the existing Ghost assignment transport, preserves newer cached revisions,
then opens `/settings?tab=overlay#ghost` with a success toast. Ordinary build
cards load neither authentication nor preference lookup code per card; the
controller loads after interaction or a matching local pending intent.

Failures and expired choices leave ordinary action buttons available. Analytics
emit only intent kind through the existing consent-aware GA helper. No account
identifiers, paths or payloads are sent. No API, collection, index, worker,
secret, provider request or production operation is added.
