/**
 * Unit tests for ``useVoiceReadout.dedup`` — the per-trigger dedupe
 * primitive that sits underneath the hook's "speak each line at most
 * once per fingerprint" contract.
 *
 * Kept in a dedicated file (rather than inside the hook test) because
 * ``consumeFingerprint`` is pure and React-free, so it can be exercised
 * without a renderer; the hook test owns the integration-level checks.
 */

import { describe, expect, test } from "vitest";
import { consumeFingerprint } from "../useVoiceReadout.dedup";

describe("consumeFingerprint", () => {
  test("stamps the ref and returns true on the first call", () => {
    const ref = { current: null as string | null };
    expect(consumeFingerprint(ref, "S|alice|Zerg|2|1||")).toBe(true);
    expect(ref.current).toBe("S|alice|Zerg|2|1||");
  });

  test("returns false on a duplicate key without re-stamping", () => {
    const ref = { current: "S|alice|Zerg|2|1||" as string | null };
    expect(consumeFingerprint(ref, "S|alice|Zerg|2|1||")).toBe(false);
    expect(ref.current).toBe("S|alice|Zerg|2|1||");
  });

  test("returns true and re-stamps when the key changes", () => {
    const ref = { current: "S|alice|Zerg|2|1||" as string | null };
    expect(consumeFingerprint(ref, "S|bob|Terran|0|0||")).toBe(true);
    expect(ref.current).toBe("S|bob|Terran|0|0||");
  });

  test("rejects empty keys so a malformed payload cannot win the dedup race", () => {
    // Empty fingerprints would normally not occur in production —
    // builders always include at least the trigger prefix — but a
    // dropped clause in a future builder change must not silently shut
    // out the next well-formed emit.
    const ref = { current: null as string | null };
    expect(consumeFingerprint(ref, "")).toBe(false);
    expect(ref.current).toBeNull();
  });

  test("subsequent calls after a reject keep the slot fresh", () => {
    const ref = { current: null as string | null };
    consumeFingerprint(ref, "");
    expect(consumeFingerprint(ref, "S|alice|Zerg|2|1||")).toBe(true);
    expect(ref.current).toBe("S|alice|Zerg|2|1||");
  });
});
