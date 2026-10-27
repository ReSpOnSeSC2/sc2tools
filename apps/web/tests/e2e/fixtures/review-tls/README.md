# Local test TLS fixture only

This self-signed certificate and its intentionally public private key exist
only for the isolated Replay Review lifecycle test's bounded HTTPS listener
on `127.0.0.1`. They contain no account or production data. Never use them for
production, install them into an OS trust/certificate store, or change hosts.

The certificate has IP SAN `127.0.0.1` and DNS SAN `localhost`, and was made
in memory with PowerShell 7/.NET `CertificateRequest` and `RSA.Create(2048)`.
The dedicated Chromium test worker permits only this public key through
`--ignore-certificate-errors-spki-list`, merging the caller's existing launch
options and arguments. It does not disable general certificate validation or
change OS trust. Its SHA-256 SubjectPublicKeyInfo fingerprint (base64) is:

`wJUMA7xGnryPZb2+HIZAP695jfsS0WzvSmbrkFM5TsU=`

The pin was computed from this PEM's RSA `ExportSubjectPublicKeyInfo()` DER
with .NET SHA-256. Replacing the fixture key requires updating the pin too.
This applies before the browser's first TLS probe, unlike a context-level
certificate-error bypass. TLS error/rejection assertions remain strict.
The listener accepts
one exact synthetic attachment path/token on its ephemeral loopback origin,
checks the peer/Host/method, and returns a constant non-replay placeholder.

Playwright's Chromium interception forwards download requests that have no
CDP `networkId` without exposing them to page or context routes. A real local
HTTPS listener lets the test retain its actual browser download, neutral
filename, completion and byte-content assertions. Cleanup closes the listener
and every owned socket and attaches its request/error/rejection ledger.
