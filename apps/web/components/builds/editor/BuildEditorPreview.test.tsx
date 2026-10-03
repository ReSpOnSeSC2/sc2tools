import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildEditorPreview } from "./BuildEditorPreview";
import type { BuildEditorPreviewAlmost } from "./BuildEditor.types";
import type { BuildRule } from "@/lib/build-rules";

afterEach(cleanup);

const ALMOST_LABEL = "Almost matches — missed one rule · click a game to inspect";

function almost(
  overrides: Partial<BuildEditorPreviewAlmost>,
): BuildEditorPreviewAlmost {
  return {
    game_id: "g-1",
    build_name: "PvZ - Stargate",
    map: null,
    result: null,
    date: null,
    failed_rule_name: "BuildVoidRay",
    failed_reason: "BuildVoidRay: needs at least 4 before 10:00, had 1",
    ...overrides,
  };
}

function renderPreview(
  rows: BuildEditorPreviewAlmost[],
  previewRules: ReadonlyArray<BuildRule>,
) {
  return render(
    <BuildEditorPreview
      preview={{
        matches: [],
        almost_matches: rows,
        scanned_games: 10,
        truncated: false,
      }}
      loading={false}
      error={null}
      rules={previewRules}
      previewRules={previewRules}
      expandedMatchId={null}
      toggleInspect={vi.fn()}
      hiddenMatchIds={new Set()}
      hideMatch={vi.fn()}
      unhideAll={vi.fn()}
      inspectCache={{}}
      inspectLoading={{}}
      previewPage={0}
      almostPage={0}
      setPreviewPage={vi.fn()}
      setAlmostPage={vi.fn()}
    />,
  );
}

const VOID_RAYS: BuildRule = {
  type: "count_min",
  name: "BuildVoidRay",
  time_lt: 600,
  count: 4,
};

describe("BuildEditorPreview almost-match reasons", () => {
  it("renders 'Needs at least 4 Void Rays before 10:00 — this game had 1.' from index + count", () => {
    renderPreview(
      [almost({ failed_rule_index: 0, failed_count: 1 })],
      [VOID_RAYS],
    );

    const text = "Needs at least 4 Void Rays before 10:00 — this game had 1.";
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByTitle(text)).toBeTruthy();
    expect(screen.getByText("Missed rule:")).toBeTruthy();
    expect(screen.queryByText(/needs at least 4 before/)).toBeNull();
    const list = screen.getByText(ALMOST_LABEL).parentElement as HTMLElement;
    expect(list.textContent).not.toMatch(/[≥≤✓✗⚙★▶]/);
  });

  it("falls back to failed_reason when fields are missing", () => {
    renderPreview(
      [
        almost({ game_id: "g-old", failed_reason: "BuildVoidRay ≥ 4 (got 1) by 10:00" }),
        almost({ game_id: "g-no-count", failed_rule_index: 0 }),
      ],
      [VOID_RAYS],
    );

    expect(screen.getByText("BuildVoidRay ≥ 4 (got 1) by 10:00")).toBeTruthy();
    expect(
      screen.getByText("BuildVoidRay: needs at least 4 before 10:00, had 1"),
    ).toBeTruthy();
    expect(screen.queryByText(/^Needs /)).toBeNull();
  });

  it("falls back when previewRules[index].name differs (stale preview)", () => {
    const stargate: BuildRule = {
      type: "before",
      name: "BuildStargate",
      time_lt: 260,
    };
    renderPreview(
      [
        almost({ game_id: "g-stale", failed_rule_index: 0, failed_count: 1 }),
        almost({
          game_id: "g-out-of-range",
          failed_rule_index: 3,
          failed_count: 1,
          failed_reason: "out of range reason",
        }),
      ],
      [stargate],
    );

    expect(
      screen.getByText("BuildVoidRay: needs at least 4 before 10:00, had 1"),
    ).toBeTruthy();
    expect(screen.getByText("out of range reason")).toBeTruthy();
    expect(screen.queryByText(/^Needs /)).toBeNull();
  });

  it("uses the right one of two Stargate rules by index", () => {
    const rules: BuildRule[] = [
      { type: "before", name: "BuildStargate", time_lt: 260 },
      { type: "count_min", name: "BuildStargate", time_lt: 400, count: 2 },
    ];
    renderPreview(
      [
        almost({
          game_id: "g-second",
          failed_rule_name: "BuildStargate",
          failed_rule_index: 1,
          failed_count: 1,
        }),
        almost({
          game_id: "g-first",
          failed_rule_name: "BuildStargate",
          failed_rule_index: 0,
          failed_count: 0,
        }),
      ],
      rules,
    );

    expect(
      screen.getByText("Needs at least 2 Stargates before 6:40 — this game had 1."),
    ).toBeTruthy();
    expect(
      screen.getByText("Needs at least 1 Stargate before 4:20 — this game had none."),
    ).toBeTruthy();
  });
});
