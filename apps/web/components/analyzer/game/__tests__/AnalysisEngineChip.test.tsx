import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AnalysisEngineChip } from "../AnalysisEngineChip";

afterEach(cleanup);

describe("AnalysisEngineChip", () => {
  it("names the reported engine and links to Re-analyze games", () => {
    render(<AnalysisEngineChip engineVersion="1.6.9" />);
    expect(screen.getByTestId("analysis-engine").textContent).toBe("Analyzed with engine 1.6.9·Re-analyze");
    expect(screen.getByRole("link", { name: "Re-analyze" }).getAttribute("href")).toBe("/settings?tab=backups#reanalyze");
  });

  it.each([undefined, null, "", "latest", "01.6.9", `1.6.9-${"x".repeat(40)}`])("treats %j as unknown", (value) => {
    render(<AnalysisEngineChip engineVersion={value} />);
    expect(screen.getByText("Engine version unknown")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Re-analyze" })).toBeTruthy();
  });
});
