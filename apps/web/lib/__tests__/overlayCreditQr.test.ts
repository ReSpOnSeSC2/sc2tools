import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OVERLAY_CREDIT_URL } from "../overlayCredit";
import { encodeOverlayCreditQr, OVERLAY_CREDIT_QR_QUIET_ZONE, OVERLAY_CREDIT_QR_SIZE } from "../overlayCreditQr";

describe("overlay credit QR", () => {
  it("matches the independent Model 2 version 2, Q, byte, mask 0 reference vector", () => {
    // Generated independently with Project Nayuki's Python QR-Code-generator
    // using make_bytes and encode_segments, exact version 2, mask 0, no ECC boost.
    const matrix = encodeOverlayCreditQr();
    const bits = matrix.map(row => row.map(Number).join("")).join("");
    expect(OVERLAY_CREDIT_URL).toBe("https://sc2tools.com");
    expect(matrix).toHaveLength(25);
    expect(matrix.every(row => row.length === 25)).toBe(true);
    expect(OVERLAY_CREDIT_QR_SIZE).toBe(33);
    expect(OVERLAY_CREDIT_QR_QUIET_ZONE).toBe(4);
    expect(createHash("sha256").update(bits).digest("hex"))
      .toBe("29a52ac50c5cf9c69019484b356c8aa9085deff510acdd49241d8d33f4d1c721");
  });
});
