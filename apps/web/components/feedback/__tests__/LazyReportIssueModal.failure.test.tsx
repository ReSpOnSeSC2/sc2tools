import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LazyReportIssueModal } from "../LazyReportIssueModal";

vi.mock("next/dynamic", () => ({
  default: () => function FailedReportChunk() {
    throw new Error("ChunkLoadError: report chunk unavailable");
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LazyReportIssueModal chunk recovery", () => {
  it("keeps the surrounding page and offers email with the report prefill", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    render(
      <>
        <main>Surrounding page</main>
        <LazyReportIssueModal
          open
          onClose={onClose}
          prefill={{ subject: "Error on /app (ref 42)", message: "Page: /app\nError ID: evt_1" }}
        />
      </>,
    );
    expect(screen.getByText("Surrounding page")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Report form unavailable" })).toBeTruthy();
    const mailto = new URL(screen.getByRole("link", { name: "Email support" }).getAttribute("href")!);
    expect(mailto.protocol).toBe("mailto:");
    expect(mailto.searchParams.get("subject")).toBe("Error on /app (ref 42)");
    expect(mailto.searchParams.get("body")).toContain("Error ID: evt_1");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
