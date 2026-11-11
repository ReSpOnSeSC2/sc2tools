// @ts-nocheck
"use strict";

const crypto = require("crypto");
const { encryptPushPayload, parseVapidKeys, vapidAuthorization, generateVapidKeys } = require("../src/services/webPushCrypto");
const { safePushEndpoint, pushGroupFor, sanitizePushGroups } = require("../src/services/pushNotifications");
const { validWebhookUrl, backoffMs } = require("../src/services/discordWebhooks");
const templates = require("../src/services/discordTemplates");
const { renderIcs, foldLine, escapeText } = require("../src/services/calendarFeed");
const { dueReminder } = require("../src/services/coachingReminders");
const { weekBounds, weekKeyAt, shiftWeek, mondayOf } = require("../src/services/reportTime");
const { fitSize, crystalBall, downsample, MAX_BYTES } = require("../src/services/streamReports");
const { sanitizeReportPrefs } = require("../src/services/reportPreferences");
const { isCredentialBodyPath, privateSearchSentryCallbacks, privateSearchHttpOptions, runPrivateSearchScope,
  PRIVATE_SEARCH_TAG } = require("../src/middleware/privateSearchTelemetry");
const { sanitiseRequestForLog } = require("../src/middleware/requestLogging");

const b64 = (value) => Buffer.from(value, "base64url");

test("Web Push encryption reproduces the RFC 8291 Appendix A message byte for byte", () => {
  const body = encryptPushPayload("When I grow up, I want to be a watermelon", {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { ephemeralPrivateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b64("DGv6ra1nlYgDCS1FRnbzlw") });
  expect(body.toString("base64url")).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  expect(() => encryptPushPayload("x", { p256dh: "short", auth: "BTBZMqHH6r4Tts7J_aSIgg" })).toThrow("invalid_push_keys");
  expect(() => encryptPushPayload("x".repeat(4000), { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" })).toThrow("push_payload_too_large");
});

test("VAPID authorization is an ES256 JWT for the push service origin, verifiable with the public key", () => {
  const pair = generateVapidKeys();
  const vapid = parseVapidKeys(pair.publicKey, pair.privateKey);
  const header = vapidAuthorization({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", subject: "mailto:owner@example.com", vapid, nowSec: 1_800_000_000 });
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(key).toBe(pair.publicKey);
  const [h, c, sig] = token.split(".");
  expect(JSON.parse(b64(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
  expect(JSON.parse(b64(c).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 12 * 3600, sub: "mailto:owner@example.com" });
  const pub = b64(pair.publicKey);
  const publicKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  expect(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, b64(sig))).toBe(true);
  expect(parseVapidKeys(generateVapidKeys().publicKey, pair.privateKey)).toBeNull();
  expect(parseVapidKeys("not-a-key", pair.privateKey)).toBeNull();
});

test("push endpoints are limited to browser push services over https", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/QGx", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
    expect(safePushEndpoint(ok)).toBe(ok);
  }
  for (const bad of ["http://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com.evil.test/x", "https://169.254.169.254/latest", "https://localhost/push",
    "https://fcm.googleapis.com:8443/x", "https://user:pw@fcm.googleapis.com/x", "https://evil.test/fcm.googleapis.com", `https://fcm.googleapis.com/${"a".repeat(1100)}`, 42]) {
    expect(safePushEndpoint(bad)).toBeNull();
  }
  expect(pushGroupFor("review.reply")).toBe("reviews");
  expect(pushGroupFor("coaching.reminder")).toBe("coaching-reminders");
  expect(pushGroupFor("report.weekly")).toBe("reports");
  expect(pushGroupFor("import.done")).toBe("other");
  expect(sanitizePushGroups(["reports", "nope", "reports"])).toEqual(["reports"]);
  expect(sanitizePushGroups(undefined)).not.toContain("other");
});

test("only Discord webhook URLs are accepted", () => {
  const token = "a".repeat(68);
  for (const host of ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]) {
    expect(validWebhookUrl(` https://${host}/api/webhooks/123456789012345678/${token} `)).toBe(`https://${host}/api/webhooks/123456789012345678/${token}`);
  }
  for (const bad of [`http://discord.com/api/webhooks/1234567/${token}`, `https://discord.com.evil.test/api/webhooks/1234567/${token}`,
    `https://evil.test/discord.com/api/webhooks/1234567/${token}`, `https://discord.com/api/webhooks/1234567/${token}?wait=true`,
    `https://discord.com/api/webhooks/1234567/${token}/../../x`, `https://discord.com:444/api/webhooks/1234567/${token}`,
    `https://user@discord.com/api/webhooks/1234567/${token}`, `https://discord.com/api/webhooks/abc/${token}`, `https://xdiscord.com/api/webhooks/1234567/${token}`, null]) {
    expect(validWebhookUrl(bad)).toBeNull();
  }
  expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
  expect(backoffMs(50)).toBe(30 * 60_000);
});

test("Discord posts hide opponent names by default, never ping, and escape user text", () => {
  const game = { gameId: "g1", result: "Defeat", myRace: "Protoss", map: "Alcyone LE", myBuild: "@everyone **2 base**", myMmr: 4100, durationSec: 754,
    date: "2026-11-10T12:00:00.000Z", opponent: { race: "Zerg", mmr: 4050, displayName: "SecretOppZed" } };
  const hidden = templates.resultMessage(game, { options: undefined, mmrDelta: -14, replaySlug: "me" });
  const text = JSON.stringify(hidden);
  expect(hidden.allowed_mentions).toEqual({ parse: [] });
  expect(text).not.toContain("SecretOppZed");
  expect(text).toContain("4,100 (−14)");
  expect(text).toContain("\\\\@everyone \\\\*\\\\*2 base\\\\*\\\\*");
  expect(hidden.embeds[0].url).toBeUndefined();
  const shown = templates.resultMessage(game, { options: { opponentNames: true, mmr: false, replayLink: true }, mmrDelta: -14, replaySlug: "me" });
  expect(JSON.stringify(shown)).toContain("SecretOppZed");
  expect(JSON.stringify(shown)).not.toContain("4,100");
  expect(shown.embeds[0].url).toBe("https://sc2tools.com/p/me/replays/g1");
  expect(templates.battleReportMessage({ headline: "H", paragraph: "P", token: "AbCdEfGhIjKlMnOp", url: "https://evil.test/x" }).embeds[0].url).toBe("https://sc2tools.com/g/AbCdEfGhIjKlMnOp#battle-report");
});

test("ICS feed lines use CRLF, escape text and fold at 75 octets", () => {
  const ics = renderIcs([{ uid: "b1@sc2tools.com", start: new Date("2026-11-12T18:00:00Z"), end: new Date("2026-11-12T19:00:00Z"),
    summary: `Coaching session with ${"Ü".repeat(60)}; and, more`, cancelled: true, sequence: 1 }], { name: "SC2 Tools coaching", now: new Date("2026-11-10T09:00:00Z") });
  expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
  expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  expect(ics).not.toMatch(/[^\r]\n/);
  for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  expect(ics).toContain("DTSTART:20261112T180000Z");
  expect(ics).toContain("STATUS:CANCELLED");
  expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:Coaching session with ${"Ü".repeat(60)}\\; and\\, more`);
  expect(escapeText("a\nb\\c")).toBe("a\\nb\\\\c");
  expect(foldLine("x".repeat(80))).toBe(`${"x".repeat(75)}\r\n ${"x".repeat(5)}`);
});

test("coaching reminders fire at 24 h and 1 h, never for windows already passed at booking time", () => {
  const start = Date.parse("2026-11-12T18:00:00Z");
  const booked = { status: "booked", startAt: new Date(start), createdAt: new Date(start - 3 * 86400_000) };
  expect(dueReminder(booked, start - 25 * 3600_000)).toBeNull();
  expect(dueReminder(booked, start - 23 * 3600_000).id).toBe("24h");
  expect(dueReminder(booked, start - 30 * 60_000).id).toBe("1h");
  expect(dueReminder({ ...booked, createdAt: new Date(start - 5 * 3600_000) }, start - 4 * 3600_000)).toBeNull();
  expect(dueReminder({ ...booked, createdAt: new Date(start - 5 * 3600_000) }, start - 50 * 60_000).id).toBe("1h");
  expect(dueReminder({ ...booked, status: "cancelled" }, start - 30 * 60_000)).toBeNull();
  expect(dueReminder(booked, start + 1)).toBeNull();
});

test("report weeks follow the user's local calendar, including DST weeks and 53-week years", () => {
  expect(weekKeyAt(Date.parse("2026-11-08T23:30:00Z"), "UTC")).toBe("2026-W45");
  expect(weekKeyAt(Date.parse("2026-11-08T23:30:00Z"), "Europe/Berlin")).toBe("2026-W46");
  const dst = weekBounds("2026-W43", "Europe/Berlin");
  expect([dst.start.toISOString(), dst.end.toISOString()]).toEqual(["2026-10-18T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
  expect(mondayOf("2026-W53")).toEqual({ y: 2026, m: 12, d: 28 });
  expect(mondayOf("2025-W53")).toBeNull();
  expect(shiftWeek("2027-W01", -1)).toBe("2026-W53");
  expect(sanitizeReportPrefs({ weekly: false, timezone: "Europe/Berlin", extra: 1 })).toEqual({ weekly: false, stream: true, timezone: "Europe/Berlin" });
  expect(sanitizeReportPrefs({ timezone: "Mars/Olympus" }).timezone).toBeNull();
});

test("stream reports stay under 5 kB and keep viewer data aggregate", () => {
  // Oversized on purpose: the builders cap every field well below this, so
  // fitSize is the backstop that keeps a future field from breaking the cap.
  const long = (n) => `${"Long name ".repeat(40)}${n}`;
  const doc = fitSize({ games: 300, matchups: Array.from({ length: 6 }, (_, i) => ({ name: `PvZ${i}`, games: 50, wins: 25, losses: 25 })),
    maps: Array.from({ length: 8 }, (_, i) => ({ name: long(i), games: 30, wins: 15, losses: 15 })), builds: Array.from({ length: 5 }, (_, i) => ({ name: long(i), games: 60, wins: 30, losses: 30 })),
    mmr: { points: downsample(Array.from({ length: 300 }, (_, i) => 4000 + i), 40) }, clips: Array.from({ length: 8 }, (_, i) => ({ minute: i, kind: "chat-spike", reason: "x".repeat(400) })) });
  expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThanOrEqual(MAX_BYTES);
  expect(doc.clips.length).toBeLessThan(8);
  expect(doc.mmr.points).toHaveLength(40);
  const ball = crystalBall([{ result: "win", picks: { "twitch:a": { pick: "win", user: "A" }, "twitch:b": { pick: "loss", user: "B" } } },
    { result: "loss", picks: { "twitch:a": { pick: "loss" }, "twitch:c": { pick: "loss" }, "twitch:d": { pick: "win" } } }]);
  expect(ball).toEqual({ rounds: 2, picks: 5, correct: 3, viewers: 4, accuracy: 60,
    top: [{ picks: 2, correct: 2 }, { picks: 1, correct: 1 }, { picks: 1, correct: 0 }, { picks: 1, correct: 0 }] });
  expect(JSON.stringify(ball)).not.toMatch(/"A"|"B"/);
});

test("delivery credentials stay out of request logs and Sentry bodies", () => {
  const secret = "A".repeat(43);
  expect(sanitiseRequestForLog({ method: "GET", originalUrl: `/v1/calendar/${secret}.ics`, headers: {}, socket: {} }).url).toBe("/v1/calendar/[redacted]");
  expect(isCredentialBodyPath("/v1/me/integrations/discord/hooks")).toBe(true);
  expect(isCredentialBodyPath("/v1/me/integrations/discord/hooks/dh_test/battle-report")).toBe(true);
  expect(isCredentialBodyPath("https://api.sc2tools.com/v1/me/push/subscriptions")).toBe(true);
  expect(isCredentialBodyPath("/v1/push/subscription-change")).toBe(true);
  expect(isCredentialBodyPath("/v1/me/push/test")).toBe(false);
});

test("private calendar feed links stay out of Sentry events and traces", () => {
  const file = `${"A".repeat(43)}.ics`;
  const callbacks = privateSearchSentryCallbacks();
  const http = privateSearchHttpOptions();
  for (const path of [`/v1/calendar/${file}`, `/V1/Calendar/${file}/?test=fixture`, `/calendar/${file}`]) {
    const url = `https://api.example.test${path}`;
    expect(http.ignoreIncomingRequests(path)).toBe(true);
    expect(http.ignoreIncomingRequestBody(path)).toBe(true);
    expect(callbacks.beforeSend({ request: { url } })).toBeNull();
    expect(callbacks.beforeSend({ sdkProcessingMetadata: { normalizedRequest: { url } } })).toBeNull();
    expect(callbacks.beforeSendTransaction({ transaction: `GET ${path}` })).toBeNull();
  }

  const next = jest.fn();
  const setTag = jest.fn();
  const sdk = { withIsolationScope: callback => callback({ setTag }), suppressTracing: jest.fn(callback => callback()) };
  runPrivateSearchScope({ originalUrl: `/v1/calendar/${file}` }, next, sdk);
  expect(setTag).toHaveBeenCalledWith(PRIVATE_SEARCH_TAG, "1");
  expect(sdk.suppressTracing).toHaveBeenCalledWith(next);
  expect(next).toHaveBeenCalledTimes(1);

  for (const path of ["/v1/me/calendar-feed", "/v1/me/export", "/v1/calendar", `/v1/calendar/${file}/child`]) {
    const event = { request: { url: path } };
    expect(http.ignoreIncomingRequests(path)).toBe(false);
    expect(callbacks.beforeSend(event)).toBe(event);
  }
});
