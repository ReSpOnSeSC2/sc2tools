// @ts-nocheck
"use strict";

/**
 * Browser replay-backup CORS (services/replayFilesCors.js): the desired
 * rule, coverage matching, automatic setup against the bucket's CORS
 * configuration, the browser-style preflight probe, and the cached status
 * service.
 *
 * MOCKS (labelled): ``client.send`` stands in for the R2 control plane
 * (GetBucketCors / PutBucketCors) and ``fetchImpl`` for R2's answer to the
 * OPTIONS preflight. The S3Client itself is real, so the probe URL is
 * signed exactly as production signs replay PUTs (signing is local; no
 * network is used anywhere in this file).
 */

const {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} = require("@aws-sdk/client-s3");

const {
  BROWSER_UPLOAD_CORS_RULE_ID,
  DETAIL,
  STATUS_MAX_AGE_MS,
  BrowserUploadCorsStatus,
  browserUploadOrigins,
  desiredRule,
  ruleCovers,
  ensureBrowserUploadCors,
  probeBrowserUploadCors,
  browserUploadStatusOf,
  buildBrowserUploadCorsStatus,
  startBrowserUploadCorsCheck,
  _internals,
} = require("../src/services/replayFilesCors");
const { buildReplayFilesFromConfig } = require("../src/services/replayFiles");

const ORIGIN = "https://sc2tools.com";
const WWW = "https://www.sc2tools.com";
const ENDPOINT = "https://acct.r2.cloudflarestorage.com";
const BUCKET = "private-replays";
const SECRET = "SECRETKEY-never-logged";
const SIGNED_HEADERS = "content-type,cache-control,content-md5,x-amz-meta-sha256";
const OTHER_RULE = {
  ID: "someone-elses-rule",
  AllowedOrigins: ["https://grafana.example"],
  AllowedMethods: ["GET"],
  AllowedHeaders: ["*"],
};

function realClient() {
  return new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIDTEST", secretAccessKey: SECRET },
  });
}

function s3Error(name, httpStatusCode) {
  const err = new Error(`${name} at ${ENDPOINT}/${BUCKET}?X-Amz-Signature=deadbeef`);
  err.name = name;
  err.Code = name;
  err.$metadata = { httpStatusCode };
  return err;
}

/**
 * MOCK R2 bucket CORS state behind ``client.send``. ``rules: null`` means
 * the bucket has no CORS configuration yet.
 */
function mockBucket({ rules = null, getError = null, putErrors = [] } = {}) {
  const state = { rules, puts: [] };
  const client = realClient();
  client.send = jest.fn(async (command) => {
    if (command instanceof GetBucketCorsCommand) {
      if (getError) throw getError;
      if (state.rules === null) throw s3Error("NoSuchCORSConfiguration", 404);
      return { CORSRules: state.rules };
    }
    if (command instanceof PutBucketCorsCommand) {
      const next = command.input.CORSConfiguration.CORSRules;
      state.puts.push(next);
      const err = putErrors.shift();
      if (err) throw err;
      state.rules = next;
      return {};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const sends = (Type) => client.send.mock.calls.filter(([c]) => c instanceof Type).length;
  return { client, state, sends };
}

/** MOCK R2 preflight answer. */
function preflight(status, headers = {}) {
  return jest.fn(async () => new Response(null, { status, headers }));
}

const GOOD_PREFLIGHT = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "PUT",
  "access-control-allow-headers": SIGNED_HEADERS,
};

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

describe("desiredRule / browserUploadOrigins", () => {
  test("keeps exact http(s) origins only, deduped, localhost outside production", () => {
    const raw = [`${ORIGIN}/`, ORIGIN, "", " * ", "https://*.sc2tools.com", "ftp://x.example",
      "https://sc2tools.com/app", "http://localhost:3000", WWW];
    expect(browserUploadOrigins(raw, { nodeEnv: "development" }))
      .toEqual([ORIGIN, "http://localhost:3000", WWW]);
    expect(browserUploadOrigins(raw, { nodeEnv: "production" })).toEqual([ORIGIN, WWW]);
  });

  test("is a PUT-only rule with the signed headers and our ID", () => {
    expect(desiredRule([ORIGIN, WWW], { nodeEnv: "production" })).toEqual({
      ID: BROWSER_UPLOAD_CORS_RULE_ID,
      AllowedOrigins: [ORIGIN, WWW],
      AllowedMethods: ["PUT"],
      AllowedHeaders: ["content-type", "cache-control", "content-md5", "x-amz-meta-sha256"],
      ExposeHeaders: ["ETag"],
      MaxAgeSeconds: 3600,
    });
  });
});

describe("ruleCovers", () => {
  const desired = desiredRule([ORIGIN, WWW], { nodeEnv: "production" });

  test("accepts exact, wildcard and case-insensitive matches", () => {
    expect(ruleCovers([desired], desired)).toBe(true);
    expect(ruleCovers([{ AllowedOrigins: ["*"], AllowedMethods: ["put"], AllowedHeaders: ["*"] }], desired)).toBe(true);
    expect(ruleCovers([{
      AllowedOrigins: ["https://sc2tools.com", "https://*.sc2tools.com"],
      AllowedMethods: ["GET", "PUT"],
      AllowedHeaders: ["Content-Type", "Cache-Control", "Content-MD5", "x-amz-*"],
    }], desired)).toBe(true);
  });

  test("rejects a rule missing an origin, PUT or a signed header", () => {
    expect(ruleCovers([{ ...desired, AllowedOrigins: [ORIGIN] }], desired)).toBe(false);
    expect(ruleCovers([{ ...desired, AllowedMethods: ["GET"] }], desired)).toBe(false);
    expect(ruleCovers([{ ...desired, AllowedHeaders: ["content-type", "content-md5"] }], desired)).toBe(false);
    expect(ruleCovers([OTHER_RULE, null], desired)).toBe(false);
    expect(ruleCovers(undefined, desired)).toBe(false);
  });
});

const ORIGINS = [ORIGIN, WWW];

describe("ensureBrowserUploadCors writes (MOCK R2 control plane)", () => {
  const origins = ORIGINS;

  test("no CORS configuration → writes our rule, re-reads it, reports configured", async () => {
    const bucket = mockBucket();
    const result = await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins, nodeEnv: "production" });
    expect(result).toEqual({ status: "configured" });
    expect(bucket.state.puts).toEqual([[desiredRule(origins, { nodeEnv: "production" })]]);
    expect(bucket.sends(GetBucketCorsCommand)).toBe(2);
  });

  test("an existing covering rule → ready, nothing written", async () => {
    const bucket = mockBucket({
      rules: [OTHER_RULE, { AllowedOrigins: ["*"], AllowedMethods: ["PUT"], AllowedHeaders: ["*"] }],
    });
    const result = await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins });
    expect(result).toEqual({ status: "ready" });
    expect(bucket.sends(PutBucketCorsCommand)).toBe(0);
  });

  test("keeps every other rule and replaces only an older copy of ours", async () => {
    const stale = { ...desiredRule([ORIGIN]), AllowedOrigins: ["https://old.sc2tools.com"] };
    const bucket = mockBucket({ rules: [OTHER_RULE, stale] });
    const result = await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins, nodeEnv: "production" });
    expect(result.status).toBe("configured");
    expect(bucket.state.puts[0]).toEqual([OTHER_RULE, desiredRule(origins, { nodeEnv: "production" })]);
  });

  test("retries without our rule ID when the store refuses the ID field; other rules stay as read", async () => {
    const bucket = mockBucket({ rules: [OTHER_RULE], putErrors: [s3Error("MalformedXML", 400)] });
    const result = await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins });
    expect(result.status).toBe("configured");
    expect(bucket.state.puts).toHaveLength(2);
    const [kept, ours] = bucket.state.puts[1];
    expect(kept).toEqual(OTHER_RULE);
    expect(ours).not.toHaveProperty("ID");
    expect(ours.AllowedMethods).toEqual(["PUT"]);
  });

});

describe("ensureBrowserUploadCors failures (MOCK R2 control plane)", () => {
  const origins = ORIGINS;

  test("AccessDenied (read or write) → no_permission; logs carry no secrets or URLs", async () => {
    const logger = silentLogger();
    const denied = mockBucket({ getError: s3Error("AccessDenied", 403) });
    expect(await ensureBrowserUploadCors({ client: denied.client, bucket: BUCKET, origins, logger }))
      .toEqual({ status: "no_permission", detail: DETAIL.NO_PERMISSION });
    expect(denied.sends(PutBucketCorsCommand)).toBe(0);

    const writeDenied = mockBucket({ rules: [], putErrors: [s3Error("Unauthorized", 401)] });
    expect((await ensureBrowserUploadCors({ client: writeDenied.client, bucket: BUCKET, origins, logger })).status)
      .toBe("no_permission");
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain("AccessDenied");
    expect(logged).not.toMatch(/X-Amz-Signature|SECRETKEY|private-replays|acct\.r2/);
  });

  test("any other failure → error with the code only", async () => {
    const bucket = mockBucket({ getError: s3Error("SlowDown", 503) });
    expect(await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins }))
      .toEqual({ status: "error", detail: "Automatic setup failed (SlowDown)" });
  });

  test("a write R2 does not keep → error", async () => {
    const bucket = mockBucket({ rules: [] });
    bucket.client.send.mockImplementation(async (command) => (
      command instanceof GetBucketCorsCommand ? { CORSRules: [OTHER_RULE] } : {}
    ));
    expect(await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins }))
      .toEqual({ status: "error", detail: DETAIL.NOT_PERSISTED });
  });

  test("no usable origin → error without touching the bucket", async () => {
    const bucket = mockBucket();
    expect(await ensureBrowserUploadCors({ client: bucket.client, bucket: BUCKET, origins: ["*"] }))
      .toEqual({ status: "error", detail: DETAIL.NO_ORIGINS });
    expect(bucket.client.send).not.toHaveBeenCalled();
  });
});

describe("probeBrowserUploadCors (MOCK preflight)", () => {
  const base = () => ({ client: realClient(), bucket: BUCKET, keyPrefix: "raw-replays/v1", origin: ORIGIN });

  test("a browser-valid preflight → ready; same path-style host as signed PUTs, no signature", async () => {
    const fetchImpl = preflight(200, GOOD_PREFLIGHT);
    expect(await probeBrowserUploadCors({ ...base(), fetchImpl })).toEqual({ status: "ready" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/${BUCKET}/raw-replays/v1-pending/_cors-probe/probe.SC2Replay`);
    expect(init.method).toBe("OPTIONS");
    expect(init.headers).toEqual({
      Origin: ORIGIN,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": SIGNED_HEADERS,
    });
  });

  test("accepts wildcard answers", async () => {
    const fetchImpl = preflight(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, PUT",
      "access-control-allow-headers": "*",
    });
    expect((await probeBrowserUploadCors({ ...base(), fetchImpl })).status).toBe("ready");
  });

  test.each([
    ["no Access-Control-Allow-Origin", 200, { ...GOOD_PREFLIGHT, "access-control-allow-origin": "" }],
    ["another origin", 200, { ...GOOD_PREFLIGHT, "access-control-allow-origin": WWW }],
    ["no PUT", 200, { ...GOOD_PREFLIGHT, "access-control-allow-methods": "GET" }],
    ["a signed header missing", 200, { ...GOOD_PREFLIGHT, "access-control-allow-headers": "content-type" }],
    ["a 403 refusal", 403, {}],
  ])("%s → missing_cors", async (_label, status, headers) => {
    const result = await probeBrowserUploadCors({ ...base(), fetchImpl: preflight(status, headers) });
    expect(result.status).toBe("missing_cors");
    expect(result.detail).toContain(`HTTP ${status}`);
  });

  test("a hung preflight → error after the timeout", async () => {
    const fetchImpl = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }));
    const result = await probeBrowserUploadCors({ ...base(), fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ status: "error", detail: "The browser check timed out after 0.02 s" });
  });

  test("a network failure → error naming only the code", async () => {
    const fetchImpl = jest.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await probeBrowserUploadCors({ ...base(), fetchImpl }))
      .toEqual({ status: "error", detail: "The browser check failed (ECONNREFUSED)" });
  });
});

/** A status service over MOCK R2 + MOCK preflight, with a manual clock. */
function service(overrides = {}) {
  const bucket = overrides.bucket || mockBucket();
  const clock = { now: Date.parse("2026-09-28T12:00:00Z") };
  const svc = new BrowserUploadCorsStatus({
    client: bucket.client,
    bucket: BUCKET,
    keyPrefix: "raw-replays/v1",
    origins: [ORIGIN],
    nodeEnv: "production",
    fetchImpl: overrides.fetchImpl || preflight(200, GOOD_PREFLIGHT),
    now: () => clock.now,
    sleep: overrides.sleep || jest.fn(async () => undefined),
    autoConfigure: overrides.autoConfigure,
    logger: silentLogger(),
  });
  return { svc, bucket, clock };
}

describe("BrowserUploadCorsStatus caching (MOCK R2 + preflight)", () => {
  test("refresh sets the rule up, verifies it, and records when it was configured", async () => {
    const { svc } = service();
    const pending = svc.refresh();
    expect(svc.getStatus().status).toBe("checking");
    expect(await pending).toEqual({
      status: "ready",
      checkedAt: "2026-09-28T12:00:00.000Z",
      configuredAt: "2026-09-28T12:00:00.000Z",
    });
    expect(svc.getStatus().status).toBe("ready");
  });

  test("a read before the first (boot) check never calls R2", () => {
    const { svc, bucket } = service();
    expect(svc.getStatus()).toEqual({ status: "unknown", checkedAt: null });
    expect(bucket.client.send).not.toHaveBeenCalled();
  });

  test("concurrent refreshes share one check (single-flight)", async () => {
    const fetchImpl = preflight(200, GOOD_PREFLIGHT);
    const { svc, bucket } = service({ fetchImpl });
    const first = svc.refresh();
    expect(svc.refresh()).toBe(first);
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bucket.sends(PutBucketCorsCommand)).toBe(1);
  });

  test("caches for maxAgeMs, then re-checks once in the background", async () => {
    const fetchImpl = preflight(200, GOOD_PREFLIGHT);
    const { svc, clock } = service({ fetchImpl });
    await svc.refresh();
    clock.now += STATUS_MAX_AGE_MS - 1;
    svc.getStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.now += 1;
    expect(svc.getStatus().status).toBe("ready");
    svc.getStatus();
    await svc.refresh(); // joins the background check started above
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock.now += 30_000;
    svc.getStatus({ maxAgeMs: 1 }); // floored to one minute
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

});

describe("BrowserUploadCorsStatus outcomes (MOCK R2 + preflight)", () => {
  test("the probe decides: no_permission when the preflight fails, ready when it passes", async () => {
    const denied = () => mockBucket({ getError: s3Error("AccessDenied", 403) });
    const blocked = service({ bucket: denied(), fetchImpl: preflight(403) });
    expect(await blocked.svc.refresh()).toMatchObject({ status: "no_permission", detail: DETAIL.NO_PERMISSION });
    const manual = service({ bucket: denied() });
    expect((await manual.svc.refresh()).status).toBe("ready");
  });

  test("re-probes once after R2's propagation delay when a fresh rule is not applied yet", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: GOOD_PREFLIGHT }));
    const sleep = jest.fn(async () => undefined);
    const { svc } = service({ fetchImpl, sleep });
    expect((await svc.refresh()).status).toBe("ready");
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  test("automatic setup off → probe only", async () => {
    const { svc, bucket } = service({ autoConfigure: false, fetchImpl: preflight(403) });
    expect(await svc.refresh()).toMatchObject({ status: "missing_cors", detail: DETAIL.AUTO_OFF });
    expect(bucket.client.send).not.toHaveBeenCalled();
  });

  test("never rejects, even when a step throws", async () => {
    const { svc } = service();
    jest.spyOn(svc, "probeAll").mockRejectedValue(new RangeError("boom"));
    expect(await svc.refresh()).toMatchObject({ status: "error", detail: "Check failed (RangeError)" });
  });
});

describe("wiring helpers", () => {
  test("disabled without a replay store; built from the replay store's client and prefix", () => {
    expect(buildBrowserUploadCorsStatus({ replayFiles: null, config: {} })).toBeNull();
    expect(browserUploadStatusOf(null)).toEqual({ status: "disabled", checkedAt: null });
    const replayFiles = buildReplayFilesFromConfig({ games: {} }, {
      replayFilesStore: "r2",
      r2: { endpoint: ENDPOINT, bucket: BUCKET, accessKeyId: "k", secretAccessKey: "s", replayPrefix: "originals/v2" },
    });
    const svc = buildBrowserUploadCorsStatus({
      replayFiles,
      config: { corsAllowedOrigins: [ORIGIN], nodeEnv: "production", r2BrowserCorsAuto: false },
    });
    expect(svc).toBeInstanceOf(BrowserUploadCorsStatus);
    expect(svc.opts).toMatchObject({ bucket: BUCKET, keyPrefix: "originals/v2", autoConfigure: false });
    expect(svc.opts.client).toBe(replayFiles.client);
  });

  test("the boot hook logs one structured line and never rejects", async () => {
    const logger = silentLogger();
    await startBrowserUploadCorsCheck({
      refresh: async () => ({ status: "ready", checkedAt: "x", configuredAt: "x" }),
    }, logger);
    expect(logger.info).toHaveBeenCalledWith({ status: "ready", configured: true }, "replay_files_browser_cors");
    await expect(startBrowserUploadCorsCheck({
      refresh: async () => {
        throw new Error("unexpected");
      },
    }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ errorCode: "Error" }, "replay_files_browser_cors_boot_failed");
    await expect(startBrowserUploadCorsCheck(null, logger)).resolves.toBeUndefined();
  });

  test("wildcards match at most one star; error codes are log-safe", () => {
    expect(_internals.wildcardMatch("x-amz-*", "X-Amz-Meta-Sha256")).toBe(true);
    expect(_internals.wildcardMatch("*-*", "a-b")).toBe(false);
    expect(_internals.errorCode({ Code: "Access Denied<script>" })).toBe("AccessDeniedscript");
    expect(_internals.errorCode("oops")).toBe("unknown");
  });
});
