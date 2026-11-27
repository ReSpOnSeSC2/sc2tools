import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArcadeTab } from "../ArcadeTab";
vi.mock("@/components/builds/useCustomBuildCatalog", () => ({ CustomBuildCatalogProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../arcade/SeasonRecap", () => ({ SeasonRecap: () => null }));
vi.mock("../arcade/surfaces/Today", () => ({ TodaySurface: () => <p>Daily challenges</p> }));
vi.mock("../arcade/surfaces/QuickPlay", () => ({ QuickPlaySurface: () => <p>Quick play challenges</p> }));
vi.mock("../arcade/surfaces/Collection", () => ({ CollectionSurface: () => null }));
vi.mock("../arcade/surfaces/MyStats", () => ({ MyStatsSurface: () => null }));
afterEach(cleanup);
it("calls the daily surface Daily and keeps its navigation working", () => {
  render(<ArcadeTab />);
  const daily = screen.getByRole("tab", { name: "Daily" });
  expect(daily.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("Daily challenges")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Quick Play" }));
  expect(screen.getByText("Quick play challenges")).toBeTruthy();
  fireEvent.click(daily); expect(screen.getByText("Daily challenges")).toBeTruthy();
});
it("links Humdingers above the Arcade tabs on every section, outside the mode catalog", () => {
  render(<ArcadeTab />);
  const play = screen.getByRole("link", { name: /^Play Humdingers/ });
  expect(play.getAttribute("href")).toBe("/play/humdingers");
  // Decorative gameplay thumbnails: the link's text already names it.
  expect([...play.querySelectorAll("img")].map((img) => [img.getAttribute("src"), img.getAttribute("alt")]))
    .toEqual([["/landing/humdingers-gameplay-1.png", ""], ["/landing/humdingers-gameplay-2.png", ""]]);
  expect(play.compareDocumentPosition(screen.getByRole("tablist", { name: "Arcade sections" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Quick Play" }));
  expect(screen.getByRole("link", { name: /^Play Humdingers/ }).getAttribute("href")).toBe("/play/humdingers");
});
