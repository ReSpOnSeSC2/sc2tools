import { describe, expect, it } from "vitest";
import {
  gameAnalysisHref,
  opponentContextFromQuery,
  opponentProfileHref,
} from "../opponentNavigation";

describe("opponent navigation context", () => {
  it("round-trips encoded ids and names through a game URL query", () => {
    const href = gameAnalysisHref("game/42", {
      pulseId: "1-S2-1-42/alt",
      displayName: "  Barcode Rival  ",
    });
    const query = new URL(href, "https://example.test").searchParams;
    const context = opponentContextFromQuery(Object.fromEntries(query));

    expect(context).toEqual({
      pulseId: "1-S2-1-42/alt",
      displayName: "Barcode Rival",
    });
    expect(opponentProfileHref(context)).toBe(
      "/app/opponents/1-S2-1-42%2Falt",
    );
  });

  it("keeps dashboard fallback behavior without an opponent id", () => {
    expect(gameAnalysisHref("game/42")).toBe("/app/game/game%2F42");
    expect(opponentContextFromQuery({ opponentName: "Name only" })).toBeNull();
    expect(opponentProfileHref(null)).toBe("/app");
  });
});
