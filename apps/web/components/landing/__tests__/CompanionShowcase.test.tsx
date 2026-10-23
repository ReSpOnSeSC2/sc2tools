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
    expect(section.textContent).toContain("Companion 0.21.1 is a preview, not included in the current stable download");
    expect(section.textContent).toContain("A signed public release is pending");
    expect(section.textContent).toContain("unsigned verification builds are separate test artifacts");
    expect(section.textContent).toContain("Choose how much you see");
    expect(section.textContent).toContain("name, race and MMR, plus your W–L and win percentage against this opponent");
    expect(section.textContent).not.toContain("name, race and MMR only");
    expect(section.textContent).toContain("opening icon chains");
    expect(section.textContent).toContain("upgrade completion chains");
    expect(section.textContent).toContain("Home and Back");
    expect(section.textContent).toContain("Separate opponent and game arrows");
    expect(section.textContent).toContain("Assistance and Agent menus");
    expect(section.textContent).toContain("native Windows system-voice reports");
    expect(section.textContent).toContain("fresh human 1v1 games");
    expect(section.textContent).toContain("OBS voice settings stay separate");
    expect(section.textContent).toContain("avoid duplicate audio");
    expect(section.textContent).toContain("Standard");
    expect(section.textContent).toContain("Detailed");
    expect(section.textContent).toContain("Full workspace");
    const compact = within(section).getByRole("img", { name: /Compact Companion showing a sample opponent/ });
    expect(compact.getAttribute("width")).toBe("360");
    expect(compact.getAttribute("height")).toBe("240");
    expect(section.textContent).toContain("Compact layout · actual interface with sample data");
  });
});
