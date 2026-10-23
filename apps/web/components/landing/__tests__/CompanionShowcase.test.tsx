import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { CompanionShowcase } from "../CompanionShowcase";

afterEach(cleanup);

describe("desktop Companion landing showcase", () => {
  it("connects the native workspace, selectors and Ghost to download and help", () => {
    const { container } = render(<CompanionShowcase />);
    const section = within(container).getByRole("region", { name: "Your ladder desk, beside the game." });
    expect(within(section).getByRole("link", { name: "Download the Windows app" }).getAttribute("href")).toBe("/download");
    expect(within(section).getByRole("link", { name: "Explore Companion" }).getAttribute("href")).toBe("/help/desktop-companion");
    expect(section.querySelectorAll("img")).toHaveLength(3);
    expect(section.textContent).toContain("screenshots use sample data");
    expect(section.textContent).toContain("Runs without OBS");
    expect(section.textContent).toContain("One game assistance switch");
    expect(section.textContent).toContain("Star a reference replay for each build");
    expect(section.textContent).toContain("explicitly published");
    expect(section.textContent).toContain("Ladder, Customs, Teams, Practice and Review presets");
    expect(section.textContent).toContain("optional Ctrl+Shift+F10");
    expect(section.textContent).toContain("Team-game guidance is not supported");
  });
});
