// @ts-nocheck
"use strict";
const { TwitchAutomationProvider, MAX_BYTES } = require("../src/services/twitchAutomationProvider");
let provider, grant;
const row = () => ({ id: "prediction-1", broadcaster_id: "42", title: "Win this game?", prediction_window: 120, status: "ACTIVE", outcomes: [{ id: "win-1", title: "Win" }, { id: "loss-1", title: "Loss" }] });
const answer = data => Response.json({ data });
beforeEach(() => { provider = new TwitchAutomationProvider({ clientId: "mock-client", timeoutMs: 100 }); grant = { accessToken: "private-mock-bearer", platformUserId: "42", assertCurrent: jest.fn(async () => {}), boundedFetch: jest.fn(async () => answer([row()])) }; });
afterEach(() => jest.useRealTimers());
test("create uses exact owned broadcaster, documented Win/Loss and complete IDs", async () => {
  expect(await provider.createPrediction(grant, "Win this game?", 120)).toEqual({ predictionId: "prediction-1", winId: "win-1", lossId: "loss-1" });
  const [url, init] = grant.boundedFetch.mock.calls[0]; expect(url).toBe("https://api.twitch.tv/helix/predictions"); expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ broadcaster_id: "42", title: "Win this game?", outcomes: [{ title: "Win" }, { title: "Loss" }], prediction_window: 120 });
});
test.each([{ outcomes: [] }, { outcomes: [{ id: "same", title: "Win" }, { id: "same", title: "Loss" }] }, { title: "Different question" }, { prediction_window: 30 }, { status: "RESOLVED" }, { id: "" }])("malformed create receipts remain uncertain and never become active: %j", async patch => {
  grant.boundedFetch.mockResolvedValue(answer([{ ...row(), ...patch }]));
  await expect(provider.createPrediction(grant, "Win this game?", 120)).rejects.toMatchObject({ code: "twitch_prediction_receipt_incomplete", uncertain: true }); expect(grant.boundedFetch).toHaveBeenCalledTimes(1);
});
test("partial create ID is retained only for the exact broadcaster, without guessed outcomes", async () => {
  grant.boundedFetch.mockResolvedValueOnce(answer([{ ...row(), outcomes: [] }]));
  await expect(provider.createPrediction(grant, "Win this game?", 120)).rejects.toMatchObject({ receipt: { predictionId: "prediction-1" } });
  grant.boundedFetch.mockResolvedValueOnce(answer([{ ...row(), broadcaster_id: "99" }]));
  await expect(provider.createPrediction(grant, "Win this game?", 120)).rejects.toMatchObject({ receipt: {} });
});
test("resolve/refund patches include only the requested exact provider/outcome IDs", async () => {
  grant.boundedFetch.mockImplementation(async (_url, init) => { const input = JSON.parse(init.body); return answer([{ ...row(), id: input.id, status: input.status, winning_outcome_id: input.winning_outcome_id }]); });
  expect(await provider.endPrediction(grant, "prediction-1", "RESOLVED", "win-1")).toEqual({ status: "RESOLVED" });
  expect(JSON.parse(grant.boundedFetch.mock.calls[0][1].body)).toEqual({ broadcaster_id: "42", id: "prediction-1", status: "RESOLVED", winning_outcome_id: "win-1" });
  await provider.endPrediction(grant, "prediction-1", "CANCELED"); expect(JSON.parse(grant.boundedFetch.mock.calls[1][1].body)).toEqual({ broadcaster_id: "42", id: "prediction-1", status: "CANCELED" });
});
test("a mismatched patch receipt cannot claim settlement or refund success", async () => {
  grant.boundedFetch.mockResolvedValue(answer([{ ...row(), id: "other", status: "CANCELED" }]));
  await expect(provider.endPrediction(grant, "prediction-1", "CANCELED")).rejects.toMatchObject({ uncertain: true });
});
test("recovery GET is restricted to the known exact prediction ID and safe projection", async () => {
  grant.boundedFetch.mockResolvedValue(answer([{ ...row(), status: "RESOLVED", winning_outcome_id: "win-1", private_viewer_data: [{ token: "never-return" }] }]));
  expect(await provider.prediction(grant, "prediction-1")).toEqual({ predictionId: "prediction-1", status: "RESOLVED", winId: "win-1", lossId: "loss-1", winningId: "win-1" });
  expect(grant.boundedFetch.mock.calls[0][0]).toBe("https://api.twitch.tv/helix/predictions?broadcaster_id=42&id=prediction-1");
  grant.boundedFetch.mockResolvedValue(answer([{ ...row(), id: "unrelated" }])); await expect(provider.prediction(grant, "prediction-1")).rejects.toThrow();
});
test("markers use the owned stream and confirm bounded position/description receipt", async () => {
  grant.boundedFetch.mockResolvedValue(answer([{ id: "marker-1", position_seconds: 93, description: "vs Opp · PvZ · Map" }]));
  expect(await provider.createMarker(grant, "vs Opp · PvZ · Map")).toEqual({ markerId: "marker-1", positionSeconds: 93 });
  expect(JSON.parse(grant.boundedFetch.mock.calls[0][1].body)).toEqual({ user_id: "42", description: "vs Opp · PvZ · Map" });
});
test("eligibility and live reads require the exact broadcaster and hide provider bodies", async () => {
  grant.boundedFetch.mockResolvedValueOnce(answer([{ id: "42", broadcaster_type: "affiliate", display_name: "Synthetic" }])).mockResolvedValueOnce(answer([{ user_id: "42", type: "live", stream_key: "must-not-return" }]));
  expect(await provider.broadcaster(grant)).toEqual({ eligible: true, name: "Synthetic" }); expect(await provider.isLive(grant)).toBe(true);
  grant.boundedFetch.mockResolvedValueOnce(answer([])); expect(await provider.isLive(grant)).toBe(false);
  grant.boundedFetch.mockResolvedValueOnce(answer([{ id: "99", broadcaster_type: "partner" }])); await expect(provider.broadcaster(grant)).rejects.toThrow();
});
test.each([400, 401, 403, 429, 500])("HTTP%s is safely classified without leaking provider error text or replaying", async status => {
  grant.boundedFetch.mockResolvedValue(new Response("private-mock-bearer secret-provider-url", { status }));
  try { await provider.createPrediction(grant, "Win this game?", 120); throw new Error("must reject"); }
  catch (error) { expect(error.status).toBe(status); expect(error.uncertain).toBe(status >= 500); expect(error.message).not.toMatch(/private-mock|secret-provider/); }
  expect(grant.boundedFetch).toHaveBeenCalledTimes(1);
});
test("a network create failure is uncertain and never transparently retried", async () => {
  grant.boundedFetch.mockRejectedValue(new Error("URL with private-mock-bearer")); await expect(provider.createPrediction(grant, "Win this game?", 120)).rejects.toMatchObject({ uncertain: true }); expect(grant.boundedFetch).toHaveBeenCalledTimes(1);
});
test("oversized provider bodies are rejected before retaining unbounded data", async () => {
  grant.boundedFetch.mockResolvedValue(new Response("x".repeat(MAX_BYTES + 1))); await expect(provider.createPrediction(grant, "Win this game?", 120)).rejects.toMatchObject({ uncertain: true, code: "twitch_automation_response_too_large" });
});
test("held response bodies reach the deadline and cannot become successful receipts later", async () => {
  jest.useFakeTimers(); const stream = new ReadableStream({ start() {} }); grant.boundedFetch.mockResolvedValue(new Response(stream));
  const pending = provider.createPrediction(grant, "Win this game?", 120); const rejected = expect(pending).rejects.toMatchObject({ code: "twitch_automation_timeout", uncertain: true });
  await jest.advanceTimersByTimeAsync(101); await rejected; expect(grant.boundedFetch.mock.calls[0][1].signal.aborted).toBe(true);
});
test("unsafe/unbounded inputs never reach Twitch", async () => {
  await expect(provider.createPrediction(grant, "x".repeat(46), 120)).rejects.toThrow(); await expect(provider.createPrediction(grant, "Win?", 1)).rejects.toThrow();
  await expect(provider.createMarker(grant, "<b>marker</b>")).rejects.toThrow(); await expect(provider.endPrediction(grant, "../other", "CANCELED")).rejects.toThrow(); expect(grant.boundedFetch).not.toHaveBeenCalled();
});
