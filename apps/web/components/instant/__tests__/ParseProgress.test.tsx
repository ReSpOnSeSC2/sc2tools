/**
 * ParseProgress — progressbar values, stage labels, cancel and the
 * grouped failure summary (counts only, no file names).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FailedParse } from "@/lib/instant/types";
import { BOOT_LABEL, ParseProgress } from "../ParseProgress";

function failure(fileName: string, errorKind: FailedParse["errorKind"]): FailedParse {
  return { ok: false, fileName, relativePath: fileName, errorKind, ms: 0 };
}

afterEach(cleanup);

describe("ParseProgress", () => {
  it("shows a determinate bar for the current step", () => {
    render(
      <ParseProgress
        phase="parsing"
        progress={{ phase: "parse", index: 2, total: 8, done: 3, fileName: "secret-name.SC2Replay" }}
        total={10}
        failed={[]}
        onCancel={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("8");
    expect(bar.getAttribute("aria-valuetext")).toBe("3 of 8");
    expect(screen.getByRole("status").textContent).toBe("Analysing replays…");
    expect(screen.queryByText(/secret-name/)).toBeNull();
  });

  it("explains the one-time download while booting and can be cancelled", () => {
    const onCancel = vi.fn();
    render(<ParseProgress phase="booting" progress={null} total={5} failed={[]} onCancel={onCancel} />);
    expect(screen.getByRole("status").textContent).toBe(BOOT_LABEL);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("groups failures by kind with counts and never lists file names", () => {
    const failed = [
      failure("alpha.SC2Replay", "ai_game"),
      failure("beta.SC2Replay", "ai_game"),
      failure("gamma.SC2Replay", "corrupt_file"),
    ];
    render(<ParseProgress phase="done" progress={null} total={3} failed={failed} onCancel={vi.fn()} />);
    const items = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^1 · Corrupt or cut-off file/);
    expect(items[1]).toMatch(/^2 · Games vs the AI/);
    expect(screen.queryByText(/alpha|beta|gamma/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
