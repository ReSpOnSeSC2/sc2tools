import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "./overlaySamples.json";
import { overlaySample } from "./overlaySamples";

const require = createRequire(import.meta.url);
const { buildSamplePayload } = require("../../api/src/services/overlayLiveSamples.js");
afterEach(() => vi.useRealTimers());
describe("one API and client fixture contract", () => {
  it("matches every registered widget and scenario at the same clock", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
    for (const widget of [undefined, ...Object.keys(fixtures.widgetKeys), "__proto__", "constructor", "invalid"]) {
      for (const { id } of fixtures.scenarios) {
        const { isTest: _test, testNonce: _nonce, testWidget: _widget, ...client } = overlaySample(widget, id);
        expect(client, `${widget}/${id}`).toEqual(buildSamplePayload(widget, id));
      }
    }
  });
  it("does not mutate shared source or a later sample", () => {
    const original = JSON.stringify(fixtures);
    const sample = overlaySample(); sample.session!.wins = 999;
    expect(overlaySample().session!.wins).not.toBe(999);
    expect(JSON.stringify(fixtures)).toBe(original);
  });
});
