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
    expect(section.querySelectorAll("img")).toHaveLength(9);
    expect(section.textContent).toContain("screenshots use sample data");
    expect(section.textContent).toContain("Runs without OBS");
    expect(section.textContent).toContain("One game assistance switch");
    expect(section.textContent).toContain("Star a reference replay for each build");
    expect(section.textContent).toContain("explicitly published");
    expect(section.textContent).toContain("Ladder, Customs, Teams, Practice and Review presets");
    expect(section.textContent).toContain("optional Ctrl+Shift+F10");
    expect(section.textContent).toContain("automatic check-ins and randomizer draws remain 1v1-only");
    expect(section.textContent).toContain("Use Agent 0.24.2 or later");
    expect(section.textContent).not.toContain("verification preview");
    expect(section.textContent).toContain("Choose how much you see");
    expect(section.textContent).toContain("transparent opponent text, race, MMR, your W–L and win percentage");
    expect(section.textContent).not.toContain("name, race and MMR only");
    expect(section.textContent).toContain("build icon chains");
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
    const compact = within(section).getByRole("img", { name: /Transparent Compact Companion/ });
    expect(compact.getAttribute("width")).toBe("420");
    expect(compact.getAttribute("height")).toBe("44");
    expect(section.textContent).toContain("520 × 480: selected opponent information");
    expect(section.textContent).toContain("1024 × 800");
    expect(section.textContent).toContain("3 minutes, then choose 6 minutes, 10 minutes or Full build order");
    expect(section.textContent).toContain("all available stored events");
    expect(section.textContent).toContain("Compact layout · actual interface with sample data");
  });

  it("explains updating the live Agent and presents race borders as a static optional comparison", () => {
    const { container } = render(<CompanionShowcase />);
    const availability = within(container).getByRole("note", { name: "Companion availability" });
    expect(availability.textContent).toContain("Update from the shared Agent menu");
    expect(availability.querySelector("strong")?.textContent).toContain("0.24.2 or later");
    expect(container.textContent).toContain("Default preserves the current purple appearance");
    expect(container.textContent).toContain("Optional Protoss, Terran and Zerg borders");
    expect(container.textContent).toContain("independent of player and opponent race");
    expect(container.textContent).toContain("only when you explicitly expand the window");
    expect(container.textContent).toContain("Turn animations off at any time for instant size changes");
    const comparison = within(container).getByRole("img", { name: /Static comparison of Default purple, Protoss, Terran and Zerg/ });
    expect(comparison.getAttribute("width")).toBe("1040");
    expect(comparison.getAttribute("height")).toBe("1016");
    expect(comparison.getAttribute("src")).toContain("companion-race-skins.png");
    expect(container.querySelector("video, audio, iframe")).toBeNull();
  });

  it("explains Hybrid team identity, manual Ghost limits and safe legacy history recovery", () => {
    const { container } = render(<CompanionShowcase />);
    const text = container.textContent;
    for (const phrase of ["Compact follows one selected enemy", "expanded layouts show the enemy roster",
      "Enemy roster", "explicitly confirm your own player", "Right-click Compact", "Historical 1v1 MMR",
      "not current team-ladder ratings", "Ambiguous identities remain unlinked until confirmed",
      "Use this target in current team game", "saved 1v1 targets stay untouched",
      "original local replay", "without resyncing or resetting upload history",
      "credential-bearing OBS SDK logs", "fresh live SC2 telemetry"]) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toContain("Team-game guidance is not supported");
    expect(within(container).getByRole("img", { name: /Native Companion after-game check-in/ }).getAttribute("src")).toContain("companion-postgame.png");
    const team = within(container).getByRole("img", { name: /Detailed Companion Hybrid team roster/ });
    expect(team.getAttribute("src")).toContain("companion-team-hybrid.png");
    expect(team.getAttribute("width")).toBe("1024");
    expect(team.getAttribute("height")).toBe("800");
  });

  it("describes optional Session, honest rating metadata and foreground-only click-through", () => {
    const { container } = render(<CompanionShowcase />);
    expect(within(container).getByRole("heading", { name: "Your Session record, between games too." })).toBeDefined();
    for (const phrase of ["Session panel is off by default", "four-hour-inactivity record", "not a calendar-day total",
      "does not require OBS or an active match", "own latest-known MMR and rating region",
      "Active server detection is unavailable", "setup requires explicit confirmation",
      "never create credentials automatically", "master assistance off hides it without resetting",
      "expire after 90 seconds", "StarCraft II is the verified foreground application", "Alt+Tab away",
      "Standard stays interactive", "Existing minimize and close-to-tray behavior is unchanged"]) {
      expect(container.textContent).toContain(phrase);
    }
    expect(container.textContent).not.toContain("verified current server");
    const gallery = within(container).getByRole("img", { name: /Native Session record panels in Default, Protoss, Terran and Zerg styles/ });
    expect(gallery.getAttribute("src")).toContain("companion-session.png");
    expect(gallery.getAttribute("width")).toBe("720");
    expect(gallery.getAttribute("height")).toBe("285");
    expect(gallery.getAttribute("sizes")).toBe("(max-width: 720px) 100vw, 720px");
    expect(container.textContent).toContain("Actual native panels · 150 × 138 each · sample data");
    expect(container.textContent).toContain("rating region are not a verified active server");
    expect(container.querySelectorAll("img")).toHaveLength(9);
  });

  it("keeps Randomizer playback in the widget without retiring native scouting voice", () => {
    const { container } = render(<CompanionShowcase />);
    for (const phrase of ["Choose a pool. Randomize from check-in.", "silently configure the shared pool",
      "Randomize saves one build even without an open widget", "Randomizer animation, sound and spoken results stay in the widget",
      "no native current-game Randomizer popup",
      "Native scouting voice is unaffected by widget-only Randomizer playback"]) {
      expect(container.textContent).toContain(phrase);
    }
    const settings = within(container).getByRole("img", { name: /Companion Randomizer pool configuration and the saved result/ });
    expect(settings.getAttribute("src")).toContain("companion-randomizer.png");
    expect(settings.getAttribute("width")).toBe("900");
    expect(settings.getAttribute("height")).toBe("480");
    expect(container.textContent).toContain("sample pool and read-only saved pick");
    expect(container.textContent).toContain("Randomize is in check-in");
  });
});
