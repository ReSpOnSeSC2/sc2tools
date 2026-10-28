# Actual local Next authority/SSR verification

This packet uses the real production Next server, middleware and installed Clerk
SDK. Only authentication key material/JWKS and API responses are synthetic and
loopback. It is not production-account acceptance. No product, SDK, Next,
middleware or HTTP-status source was patched.

The exact installed Clerk Next 6.9.5 integration does not consume
`CLERK_JWT_KEY` from the environment. Its supported `CLERK_API_URL` path instead
points the real SDK at the owned loopback `/v1/jwks` responder. Every run creates
an ephemeral RSA private key/JWT in memory; only the generated public JWK and
token fingerprint are recorded. The real signature verifier rejects a token
signed by another key, and accepts the synthetic signed-in token, which the
actual server `apiFetch` forwards to the synthetic detail API. No real account,
provider, cookie or credential was accessed.

The runner was syntax-checked, then executed sequentially under the root's
exclusive slot. Raw Node HTTP follows no redirects and executes no browser
scripts. The child environment contains explicit dummy/local values and only
minimal Windows runtime variables. Actual Next env files are rejected before
launch. Existing listeners are never adopted or stopped. The owned API binds
only IPv4/IPv6 loopback; Next uses the loopback-only `localhost` name so this
Windows machine's `::1` rewrite resolution matches its listener.

## Results

Use `shared-analysis-http-comparison-02.json` and its pinned original receipts.
Both baseline and candidate have **7/9 strict cases passing**. The repair
introduces no status or authority-request-count difference across all nine:

- Invalid-signature and signed-out documents retain the actual 307 protection.
- The held missing replay is observed only after the authenticated API request
  enters the gate. During the approximately 250 ms measured hold, no Next
  response headers arrive. Releasing the API produces a real 404 without replay
  identity or an analysis loading success shell. Dotted IDs also return 404.
- Canonical owner and legacy detail redirects retain their 307/308 destination
  and exact `from` context, verified from retained response locations.
- The existing authenticated detail busy/outage surfaces remain HTTP 200 with
  their current recovery text, on both builds.
- Admitted complete responses contain actual analysis heading, timeline,
  mechanics and Pylon markup after all script/style tags are stripped. They
  contain no CSR bailout marker. This verifies actual SSR content, not merely
  DTO text inside RSC scripts or a permanent skeleton.
- Normal success/missing/error detail cases make one authority read. Both
  redirect cases make **two** on the baseline and candidate, so their strict
  one-call assertions remain failed. No assertion was deleted or relaxed.
  This existing measured behavior remains an explicit open finding.

The original runtime failures are preserved: first sandbox loopback EACCES
before any cases, then the IPv4-only fixture listener's inability to receive
the installed Clerk/Next localhost rewrite on `::1`. Only fixture transport and
diagnostic recording were corrected. All HTML, logs and strict failures remain.

Final baseline PID 42436 and candidate PID 47100 exited. Original receipts verify
owned API 8080 and Next 3326/3327 listeners closed on both IPv4 and IPv6. The heavy
slot was released to root. No further server launch is planned by this agent.

The existing independent real dynamic-chunk browser fixture remains separate:
this HTTP runner proves authority/status/SSR, not browser hydration, responsive
geometry or a live production signed-in account.
