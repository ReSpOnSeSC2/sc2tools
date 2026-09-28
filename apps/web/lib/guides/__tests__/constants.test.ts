import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { GUIDE_PAGE_MIN_GAMES, GUIDE_THIN_SAMPLE_GAMES } from "@/lib/guides/guideCopy";
import { GUIDE_MARKDOWN_MAX_CHARS } from "@/lib/guides/markdown";

// The web mirrors a few API constants (it cannot import apps/api at
// runtime); this pins them to apps/api/src/config/guides.js.
interface ApiGuideConfig {
  GUIDE_PAGE_MIN_GAMES: number;
  GUIDE_NOTE_MAX_CHARS: number;
}

function loadApiGuideConfig(): ApiGuideConfig {
  const load = createRequire(import.meta.url);
  return load(resolve(process.cwd(), "../api/src/config/guides.js")) as ApiGuideConfig;
}

describe("guide constants mirror the API", () => {
  test("page floor and thin-sample threshold", () => {
    expect(GUIDE_PAGE_MIN_GAMES).toBe(loadApiGuideConfig().GUIDE_PAGE_MIN_GAMES);
    expect(GUIDE_THIN_SAMPLE_GAMES).toBe(2 * GUIDE_PAGE_MIN_GAMES);
  });

  test("coach's note length cap", () => {
    expect(GUIDE_MARKDOWN_MAX_CHARS).toBe(loadApiGuideConfig().GUIDE_NOTE_MAX_CHARS);
  });
});
