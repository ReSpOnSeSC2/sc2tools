# Community Builds API (v1)

Base URL (production): `https://sc2-community-builds.onrender.com`
Route prefix: `/v1/community-builds`

All write requests must include:

| Header                | Value                                              |
|-----------------------|----------------------------------------------------|
| `X-Client-Id`         | Hex-encoded salted install id (16..128 chars).     |
| `X-Client-Signature`  | `HMAC-SHA256(server_pepper, raw_request_body)`     |
| `Content-Type`        | `application/json` (required for POST/PUT).        |

The signature is computed over the raw bytes of the request body. For
GET/DELETE with an empty body, sign an empty buffer.

## Build object

```jsonc
{
  "id": "proto-1-gate-expand",          // kebab-case, 3..80 chars
  "name": "1 Gate Expand",
  "race": "Protoss",                    // Protoss | Terran | Zerg
  "vsRace": "Terran",                   // Protoss | Terran | Zerg | Random
  "tier": "A",                          // S | A | B | C | null
  "description": "...",
  "winConditions": ["..."],
  "losesTo": ["..."],
  "transitionsInto": ["..."],
  "signature": [
    { "t": 17, "what": "Pylon", "weight": 0.6 }
  ],
  "toleranceSec": 15,                   // 5..60
  "minMatchScore": 0.6,                 // 0.3..1.0
  "authorClientId": "<hex>",
  "authorDisplay": "BattleTag#1234",
  "createdAt": 1714280000000,
  "updatedAt": 1714280000000,
  "deletedAt": null,
  "upvotes": 0,
  "downvotes": 0,
  "flagged": 0,
  "version": 1
}
```

## Endpoints

### `GET /health`
Liveness probe. No auth. Returns `{ ok, service, version }`.

### `GET /handshake`
Returns the current server pepper as hex so a freshly-installed client
can begin signing requests. Pair with HTTPS in production.

Response: `{ service, version, pepperHex, algorithm: "HMAC-SHA256" }`.

### `GET /`
List builds (paginated). Query parameters:

| Param    | Notes                                                       |
|----------|-------------------------------------------------------------|
| `race`   | Optional filter.                                            |
| `vsRace` | Optional filter.                                            |
| `q`      | Case-insensitive substring match on `name`.                 |
| `since`  | Epoch ms. Returns builds with `updatedAt >= since`.         |
| `sort`   | `recent` (default) or `votes`.                              |
| `limit`  | 1..100. Defaults to 50.                                     |
| `cursor` | Opaque cursor returned by the previous page.                |

Response: `{ builds: BuildObject[], nextCursor: string | null }`.

### `GET /:id`
Returns a single build, or 404 when missing / soft-deleted / hidden.

### `POST /`
Create a build. Auth required. Returns 201 with the stored object.
Errors: `409 build_exists`, `400 validation`, `401 bad_signature`.

### `PUT /:id`
Replace a build you authored. Body must use the same `id`. Bumps
`version`, preserves `createdAt`, `upvotes`, `downvotes`, `flagged`.
Errors: `404 not_found`, `403 not_author`, `400 id_mismatch`.

### `DELETE /:id`
Soft-delete a build you authored. Returns 204.

### `POST /:id/vote`
Body: `{ "vote": 1 }` or `{ "vote": -1 }`. Idempotent per `(client, build)`.
Returns the new totals: `{ upvotes, downvotes }`.

### `POST /:id/flag`
Optional body: `{ "reason": "spam" }`. Idempotent per `(client, build)`.
Builds with `flagged > 5` are hidden from `GET /` and `GET /:id` until
moderated. Returns `{ flagged }`.

### `GET /sync?since=<epoch>`
Incremental sync diff. Returns:

```jsonc
{
  "upserts": [BuildObject, ...],
  "deletes": ["build-id", ...],
  "serverNow": 1714280000000
}
```

Use `serverNow` as the `since` for the next call.

## Error shape

All errors return JSON: `{ "error": "code", "requestId": "<hex>" }`.
Validation errors include `details: [{ path, message, keyword, params }]`.

## Rate limits

- 1000 reads / hour / IP.
- 30 writes / hour / client id.
- Standard `RateLimit-*` headers on every response.
