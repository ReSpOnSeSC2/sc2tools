// @ts-nocheck
"use strict";

/**
 * Guards the overlay-token widget allowlist contract:
 *   - `KNOWN_WIDGETS` is the set the toggle endpoint accepts and MUST
 *     include the opt-in `randomizer` widget (the merged PR #430 shipped
 *     the widget row + route but missed this server-side allowlist, so
 *     toggling it on returned `unknown_widget`).
 *   - `DEFAULT_WIDGETS` (what a freshly minted token starts with) keeps
 *     `randomizer` OFF so it stays opt-in.
 */

const {
  DEFAULT_WIDGETS,
  KNOWN_WIDGETS,
} = require("../src/services/overlayTokens");

describe("overlay-token widget allowlist", () => {
  test("randomizer is a known (togglable) widget", () => {
    expect(KNOWN_WIDGETS).toContain("randomizer");
  });

  test("randomizer is opt-in — not enabled by default", () => {
    expect(DEFAULT_WIDGETS).not.toContain("randomizer");
  });

  test("KNOWN_WIDGETS is a superset of DEFAULT_WIDGETS", () => {
    for (const w of DEFAULT_WIDGETS) {
      expect(KNOWN_WIDGETS).toContain(w);
    }
  });
});
