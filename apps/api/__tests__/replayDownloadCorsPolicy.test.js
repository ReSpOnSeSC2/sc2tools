// @ts-nocheck
"use strict";
const { desiredDownloadRule, downloadRuleCovers, mergeDownloadRules, downloadCorsStatus,
  BROWSER_DOWNLOAD_CORS_RULE_ID } = require("../src/services/replayDownloadCorsPolicy");
const { desiredRule, ensureBrowserUploadCors, BrowserUploadCorsStatus,
  BROWSER_UPLOAD_CORS_RULE_ID } = require("../src/services/replayFilesCors");
const { GetBucketCorsCommand, PutBucketCorsCommand } = require("@aws-sdk/client-s3");
const ORIGIN = "https://sc2tools.com";

test("prospective GET policy uses exact origins and never equates PUT readiness with GET coverage", () => {
  const get = desiredDownloadRule([ORIGIN, `${ORIGIN}/`, "*", "https://sc2tools.com/path", "https://user:pass@sc2tools.com", "http://localhost:3000"], { nodeEnv: "production" });
  expect(get).toMatchObject({ ID: BROWSER_DOWNLOAD_CORS_RULE_ID, AllowedMethods: ["GET"], AllowedOrigins: [ORIGIN] });
  expect(get.ID).not.toBe(BROWSER_UPLOAD_CORS_RULE_ID);
  expect(downloadRuleCovers([desiredRule([ORIGIN])], get)).toBe(false);
  expect(downloadRuleCovers([get], get)).toBe(true);
  expect(downloadRuleCovers([{ ...get, ExposeHeaders: ["ETag"] }], get)).toBe(false);
  expect(downloadRuleCovers([get], desiredDownloadRule([]))).toBe(false);
});

test("pure merge retains PUT, unrelated and ID-less rules byte-for-byte without mutating caller inputs", () => {
  const put = Object.freeze(desiredRule([ORIGIN])), noId = Object.freeze({ AllowedMethods: ["HEAD"], AllowedOrigins: [ORIGIN] });
  const unrelated = Object.freeze({ ID: "operator-rule", AllowedMethods: ["DELETE"], AllowedOrigins: [ORIGIN] });
  const oldGet = { ...desiredDownloadRule([ORIGIN]), AllowedOrigins: ["https://old.invalid"] };
  const existing = Object.freeze([put, noId, unrelated, oldGet]), before = JSON.stringify(existing);
  const get = desiredDownloadRule([ORIGIN]);
  expect(mergeDownloadRules(existing, get)).toEqual([put, noId, unrelated, get]);
  expect(JSON.stringify(existing)).toBe(before);
});

test("future ordinary automatic PUT repair preserves an existing separate GET rule and never adds GET itself", async () => {
  const get = desiredDownloadRule([ORIGIN]), unrelated = { AllowedOrigins: ["https://other.invalid"], AllowedMethods: ["HEAD"] };
  let rules = [get, unrelated, { ...desiredRule([ORIGIN]), AllowedOrigins: ["https://old.invalid"] }];
  const commands = [];
  const client = { send: jest.fn(async command => {
    commands.push(command);
    if (command instanceof GetBucketCorsCommand) return { CORSRules: rules };
    if (command instanceof PutBucketCorsCommand) { rules = command.input.CORSConfiguration.CORSRules; return {}; }
    throw new Error("unexpected mock command");
  }) };
  expect(await ensureBrowserUploadCors({ client, bucket: "mock-bucket", origins: [ORIGIN] })).toEqual({ status: "configured" });
  const written = commands.find(command => command instanceof PutBucketCorsCommand).input.CORSConfiguration.CORSRules;
  expect(written).toEqual([get, unrelated, desiredRule([ORIGIN])]);
  expect(written.filter(rule => rule.ID === BROWSER_UPLOAD_CORS_RULE_ID)[0].AllowedMethods).toEqual(["PUT"]);
});

test("passive upload status and automatic PUT rules do not invoke or infer GET verification", () => {
  const client = { send: jest.fn() }, fetch = jest.fn(), signer = jest.fn();
  const status = new BrowserUploadCorsStatus({ client, bucket: "mock-bucket", origins: [ORIGIN], fetchImpl: fetch, signer });
  expect(status.getStatus()).toEqual({ status: "unknown", checkedAt: null });
  expect(client.send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(signer).not.toHaveBeenCalled();
  expect(desiredRule([ORIGIN]).AllowedMethods).toEqual(["PUT"]);
  expect(downloadCorsStatus({ uploadReady: true })).toEqual({ status: "unknown", checkedAt: null });
  expect(downloadCorsStatus({ method: "PUT", result: "ready", checkedAt: "2026-11-02T00:00:00Z" }).status).toBe("unknown");
});

test.each(["ready", "missing_cors", "no_permission", "error"])("separate status accepts only an explicit dated GET check: %s", result => {
  expect(downloadCorsStatus({ method: "GET", result, checkedAt: "2026-11-02T00:00:00Z" }))
    .toEqual({ status: result, checkedAt: "2026-11-02T00:00:00.000Z" });
  expect(downloadCorsStatus({ method: "GET", result, checkedAt: "invalid private error" }).status).toBe("unknown");
});
