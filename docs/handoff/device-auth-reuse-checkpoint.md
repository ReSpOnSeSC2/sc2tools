# Device authentication reuse: prerequisite audit

The requested 60-second credential reuse remains unfinished. Existing minute
device touches and 30-second latest-agent metadata reuse are delivered and must
not be rebuilt. `findTokenByHash` still performs an authoritative lookup.

The source audit covered issue, revoke, revoke-by-ID, heartbeat/touch/label/event
markers, GDPR erasure/restore, unknown write outcomes and delayed credential
loads. Existing liveness retirement intentionally permits an older metadata DTO;
that contract cannot authorize a request with a revoked token.

Before adoption, establish serving-process and rolling-deployment coherence or
design an explicit cross-process revocation contract. One Render service page
showing Live does not prove only one process can serve throughout deployment.
Loads started before their owner is known need a global retirement fence; final
authorization admission must also reject a retired credential. REST and socket
handshakes currently share the lookup, so any narrower reuse boundary must be
explicit and preserve authoritative socket authentication.

No authentication cache, provider configuration or flag was changed by this
audit. Detailed local contract, 12 writer cases and 15 source pins are retained
in `C:/SC2TOOLS/.cache/device-auth-reuse-audit-20261027.json`. Future implementation
requires focused issue/revoke/GDPR/unknown-outcome/delayed-load tests and actual
deployment-lifecycle verification. The broader dashboard item remains partial.
