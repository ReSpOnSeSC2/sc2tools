/**
 * SectionPanel loads each analyzer section as its own chunk: only the
 * section on screen is fetched, and the route's skeleton shows while it
 * arrives. Every section is a MOCK stub that records when its module loads.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const loaded = vi.hoisted(() => new Set<string>());

vi.mock("../replays/ReplayLibrary", () => {
  loaded.add("replays");
  return { ReplayLibrary: () => <p>replays section</p> };
});
vi.mock("../StrategiesTab", () => {
  loaded.add("strategies");
  return { StrategiesTab: () => <p>strategies section</p> };
});
vi.mock("../TrendsTab", () => {
  loaded.add("trends");
  return { TrendsTab: () => <p>trends section</p> };
});
vi.mock("../MacroTab", () => {
  loaded.add("macro");
  return { MacroTab: () => <p>macro section</p> };
});
vi.mock("../BattlefieldTab", () => {
  loaded.add("battlefield");
  return { BattlefieldTab: () => <p>maps section</p> };
});
vi.mock("../BuildsTab", () => {
  loaded.add("builds");
  return { BuildsTab: () => <p>builds section</p> };
});
vi.mock("../ArcadeTab", () => {
  loaded.add("arcade");
  return { ArcadeTab: () => <p>arcade section</p> };
});

import { SectionPanel } from "../SectionPanel";

afterEach(cleanup);

describe("SectionPanel", () => {
  it("loads only the section on screen", async () => {
    const { container } = render(<SectionPanel tab="macro" />);
    // The route skeleton shows while the chunk arrives.
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(await screen.findByText("macro section")).toBeTruthy();
    expect([...loaded]).toEqual(["macro"]);
  });

  it("puts the section header (h2, intro, How to read this) above the section", async () => {
    render(<SectionPanel tab="trends" />);
    expect(screen.getByRole("heading", { level: 2, name: "Trends" })).toBeTruthy();
    expect(screen.getByText("Win-rate trajectory across periods.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "How to read this" }).getAttribute("href")).toBe("/help/trends");
    expect(await screen.findByText("trends section")).toBeTruthy();
  });

  it("renders each section for its tab", async () => {
    const cases = [
      ["replays", "replays section"],
      ["strategies", "strategies section"],
      ["trends", "trends section"],
      ["battlefield", "maps section"],
      ["builds", "builds section"],
      ["arcade", "arcade section"],
    ] as const;
    for (const [tab, text] of cases) {
      render(<SectionPanel tab={tab} />);
      expect(await screen.findByText(text)).toBeTruthy();
      cleanup();
    }
  });

  it("imports no section statically", () => {
    const source = readFileSync(path.join(process.cwd(), "components/analyzer/SectionPanel.tsx"), "utf8");
    expect(source).not.toMatch(/^import .*(Tab|ReplayLibrary)"?;?$/m);
    expect(source.match(/dynamic\(/g)?.length).toBe(7);
  });
});
