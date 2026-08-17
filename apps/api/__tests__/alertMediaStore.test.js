"use strict";

const {
  AlertMediaStore,
  buildAlertMediaStore,
  LISTING_CACHE_TTL_MS,
} = require("../src/services/alertMediaStore");

/**
 * Minimal stand-in for S3Client. Records the commands it receives so the
 * tests can assert on prefix, pagination and cache behaviour without touching
 * the network.
 *
 * Returns `any` deliberately: the store only calls `.send()`, and structurally
 * satisfying the real S3Client type would mean stubbing config, destroy and
 * middlewareStack for no test value.
 *
 * @param {any[]} pages queued ListObjectsV2 responses, consumed in order
 * @returns {any}
 */
function fakeClient(pages) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    /** @param {any} command */
    async send(command) {
      calls.push(command);
      const page = pages.shift() || { Contents: [] };
      return page;
    },
  };
}

/**
 * Deterministic signer: encodes the key so assertions can read it back.
 *
 * @param {any} _client
 * @param {any} command
 * @param {any} opts
 * @returns {Promise<string>}
 */
async function fakeSigner(_client, command, opts) {
  return `https://signed.example/${command.input.Key}?exp=${opts.expiresIn}`;
}

/**
 * @param {string[]} keys
 * @param {string} [nextToken]
 * @returns {any}
 */
function listPage(keys, nextToken) {
  return {
    Contents: keys.map((/** @type {string} */ Key) => ({ Key })),
    NextContinuationToken: nextToken,
  };
}

describe("AlertMediaStore", () => {
  test("maps every delivery object to a presigned URL keyed by catalog path", async () => {
    const client = fakeClient([
      listPage(["alerts/sc2-3d/zealot-dance-3d.webm", "alerts/sc2-3d/zealot-dance-3d.webp"]),
    ]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", expiresSec: 300, signer: fakeSigner,
    });

    const grant = await store.createGrant();

    // The catalog stores root-relative paths, so keys gain a leading slash.
    expect(Object.keys(grant.urls).sort()).toEqual([
      "/alerts/sc2-3d/zealot-dance-3d.webm",
      "/alerts/sc2-3d/zealot-dance-3d.webp",
    ]);
    expect(grant.urls["/alerts/sc2-3d/zealot-dance-3d.webm"])
      .toBe("https://signed.example/alerts/sc2-3d/zealot-dance-3d.webm?exp=300");
    expect(grant.expiresIn).toBe(300);
  });

  test("lists under the configured prefix only", async () => {
    const client = fakeClient([listPage([])]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", signer: fakeSigner,
    });
    await store.createGrant();
    expect(client.calls[0].input.Prefix).toBe("alerts/sc2-3d/");
    expect(client.calls[0].input.Bucket).toBe("b");
  });

  test("skips directory placeholders and non-media objects", async () => {
    const client = fakeClient([
      listPage([
        "alerts/sc2-3d/",                       // placeholder
        "alerts/sc2-3d/notes.txt",              // wrong type
        "alerts/sc2-3d/frame_0001.png",         // frames are archive-only
        "alerts/sc2-3d/marine-skyfire-3d.webm", // keep
        "alerts/sc2-3d/marine-skyfire-3d.webp", // keep
      ]),
    ]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", signer: fakeSigner,
    });
    const grant = await store.createGrant();
    expect(Object.keys(grant.urls).sort()).toEqual([
      "/alerts/sc2-3d/marine-skyfire-3d.webm",
      "/alerts/sc2-3d/marine-skyfire-3d.webp",
    ]);
  });

  test("follows pagination", async () => {
    const client = fakeClient([
      listPage(["alerts/sc2-3d/a.webm"], "cursor-1"),
      listPage(["alerts/sc2-3d/b.webm"]),
    ]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", signer: fakeSigner,
    });
    const grant = await store.createGrant();
    expect(Object.keys(grant.urls).sort())
      .toEqual(["/alerts/sc2-3d/a.webm", "/alerts/sc2-3d/b.webm"]);
    expect(client.calls[1].input.ContinuationToken).toBe("cursor-1");
  });

  test("reuses the listing within its TTL, then refreshes", async () => {
    let now = 1_000;
    const client = fakeClient([
      listPage(["alerts/sc2-3d/a.webm"]),
      listPage(["alerts/sc2-3d/a.webm", "alerts/sc2-3d/b.webm"]),
    ]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", signer: fakeSigner,
      now: () => now,
    });

    await store.createGrant();
    await store.createGrant();
    expect(client.calls).toHaveLength(1); // second call served from cache

    now += LISTING_CACHE_TTL_MS + 1;
    const grant = await store.createGrant();
    expect(client.calls).toHaveLength(2);
    expect(Object.keys(grant.urls)).toHaveLength(2);
  });

  test("concurrent callers share one listing request", async () => {
    const client = fakeClient([listPage(["alerts/sc2-3d/a.webm"])]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", signer: fakeSigner,
    });
    await Promise.all([store.createGrant(), store.createGrant(), store.createGrant()]);
    expect(client.calls).toHaveLength(1);
  });

  test("invalidate() forces a fresh listing", async () => {
    const client = fakeClient([
      listPage(["alerts/sc2-3d/a.webm"]),
      listPage(["alerts/sc2-3d/a.webm", "alerts/sc2-3d/b.webm"]),
    ]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "alerts/sc2-3d", signer: fakeSigner,
    });
    await store.createGrant();
    store.invalidate();
    const grant = await store.createGrant();
    expect(client.calls).toHaveLength(2);
    expect(Object.keys(grant.urls)).toHaveLength(2);
  });

  test("normalises a prefix given with stray slashes", async () => {
    const client = fakeClient([listPage([])]);
    const store = new AlertMediaStore({
      client, bucket: "b", prefix: "/alerts/sc2-3d/", signer: fakeSigner,
    });
    await store.createGrant();
    expect(client.calls[0].input.Prefix).toBe("alerts/sc2-3d/");
  });

  test("defaults expiry to 300s when given a non-positive value", () => {
    const store = new AlertMediaStore({
      client: fakeClient([]), bucket: "b", expiresSec: 0, signer: fakeSigner,
    });
    expect(store.expiresSec).toBe(300);
  });
});

describe("buildAlertMediaStore", () => {
  const full = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    accessKeyId: "id",
    secretAccessKey: "secret",
    alertMediaBucket: "sc2tools-alert-media",
    alertMediaPrefix: "alerts/sc2-3d",
    alertMediaExpiresSec: 120,
  };

  test("builds a store when fully configured", () => {
    const store = buildAlertMediaStore(full);
    expect(store).toBeInstanceOf(AlertMediaStore);
    if (!store) throw new Error("expected a store");
    expect(store.bucket).toBe("sc2tools-alert-media");
    expect(store.expiresSec).toBe(120);
  });

  // A null store makes the endpoints answer 503 instead of crashing at boot:
  // every non-3D preset is code-native and must keep working without R2.
  test.each([
    ["null config", null],
    ["missing endpoint", { ...full, endpoint: "" }],
    ["missing bucket", { ...full, alertMediaBucket: "" }],
    ["missing access key", { ...full, accessKeyId: "" }],
    ["missing secret", { ...full, secretAccessKey: "" }],
  ])("returns null for %s", (_label, cfg) => {
    expect(buildAlertMediaStore(cfg)).toBeNull();
  });

  // R2 tokens are bucket-scoped, so the replay-store token cannot read the
  // alert bucket. Production supplies a dedicated Object Read only token.
  describe("credential selection", () => {
    /** @param {any} store @returns {Promise<any>} */
    const credsOf = async (store) => store.client.config.credentials();

    test("prefers the dedicated pair when both halves are set", async () => {
      const store = buildAlertMediaStore({
        ...full,
        alertMediaAccessKeyId: "alert-id",
        alertMediaSecretAccessKey: "alert-secret",
      });
      await expect(credsOf(store)).resolves.toMatchObject({
        accessKeyId: "alert-id",
        secretAccessKey: "alert-secret",
      });
    });

    test("falls back to the shared pair when the dedicated one is unset", async () => {
      const store = buildAlertMediaStore(full);
      await expect(credsOf(store)).resolves.toMatchObject({
        accessKeyId: "id",
        secretAccessKey: "secret",
      });
    });

    test.each([
      ["only the key is set", { alertMediaAccessKeyId: "alert-id" }],
      ["only the secret is set", { alertMediaSecretAccessKey: "alert-secret" }],
    ])("ignores a half-set dedicated pair when %s", async (_label, partial) => {
      const store = buildAlertMediaStore({ ...full, ...partial });
      await expect(credsOf(store)).resolves.toMatchObject({
        accessKeyId: "id",
        secretAccessKey: "secret",
      });
    });

    test("returns null when a half-set pair has no shared fallback", () => {
      expect(buildAlertMediaStore({
        ...full,
        accessKeyId: "",
        secretAccessKey: "",
        alertMediaAccessKeyId: "alert-id",
      })).toBeNull();
    });

    test("builds from the dedicated pair alone, with no shared credentials", async () => {
      const store = buildAlertMediaStore({
        ...full,
        accessKeyId: "",
        secretAccessKey: "",
        alertMediaAccessKeyId: "alert-id",
        alertMediaSecretAccessKey: "alert-secret",
      });
      expect(store).toBeInstanceOf(AlertMediaStore);
      await expect(credsOf(store)).resolves.toMatchObject({
        accessKeyId: "alert-id",
      });
    });
  });
});
