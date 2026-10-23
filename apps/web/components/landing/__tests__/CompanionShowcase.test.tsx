import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { CompanionShowcase } from "../CompanionShowcase";

afterEach(cleanup);

describe("desktop Companion landing showcase", () => {
  it("connects the native workspace, selectors and Ghost to download and help", () => {
    const { container } = render(<CompanionShowcase />);
    const section = within(container).getByRole("region", { name: "Your ladder desk, beside the game." });
    expect(within(section).getByRole("link", { name: "Download current stable agent" }).getAttribute("href")).toBe("/download");
    expect(within(section).getByRole("link", { name: "Explore Companion" }).getAttribute("href")).toBe("/help/desktop-companion");
    expect(section.querySelectorAll("img")).toHaveLength(4);
    expect(section.textContent).toContain("screenshots use sample data");
    expect(section.textContent).toContain("Runs without OBS");
    expect(section.textContent).toContain("One game assistance switch");
    expect(section.textContent).toContain("Star a reference replay for each build");
    expect(section.textContent).toContain("explicitly published");
    expect(section.textContent).toContain("Ladder, Customs, Teams, Practice and Review presets");
    expect(section.textContent).toContain("optional Ctrl+Shift+F10");
    expect(section.textContent).toContain("Team-game guidance is not supported");
    expect(section.textContent).toContain("Companion preview");
    expect(section.textContent).toContain("Companion 0.21.0 is a preview, not included in the current stable download");
    expect(section.textContent).toContain("A signed public release is pending");
    expect(section.textContent).toContain("unsigned verification builds are separate test artifacts");
    expect(section.textContent).toContain("Choose how much you see");
    expect(section.textContent).toContain("name, race and MMR only");
    expect(section.textContent).toContain("Standard");
    expect(section.textContent).toContain("Detailed");
    expect(section.textContent).toContain("Full workspace");
    expect(within(section).getByRole("img", { name: /Compact Companion showing only a sample opponent/ }).getAttribute("width")).toBe("360");
    expect(section.textContent).toContain("Compact layout · actual interface with sample data");
  });
});
