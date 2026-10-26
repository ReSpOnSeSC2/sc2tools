import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps loading boundaries from flushing a public 200 before authoritative status is known", () => {
  // Browser E2E checks the actual statuses. This documents why moving a
  // generic loading skeleton back into these segments regresses 404/5xx.
  for (const segment of ["", "p", "p/[handle]", "players", "players/[player]", "players/[player]/replays", "players/[player]/replays/[gameId]", "community", "community/authors", "community/authors/[userId]"]) {
    expect(existsSync(path.join(process.cwd(), "app", segment, "loading.tsx")), segment).toBe(false);
  }
  expect(existsSync(path.join(process.cwd(), "app/community/(directory)/loading.tsx"))).toBe(true);
});
