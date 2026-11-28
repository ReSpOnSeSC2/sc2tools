import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NEW_FEATURE_GROUPS } from "@/lib/landingNewFeatures";
import { WhatsNewShowcase } from "../WhatsNewShowcase";

afterEach(cleanup);

const CARDS = NEW_FEATURE_GROUPS.flatMap((group) => group.cards);
const PUBLIC_DIR = path.join(__dirname, "../../../public");

it("groups the cards under short headings with the Randomizer lead first", () => {
  render(<WhatsNewShowcase />);
  expect(screen.getByRole("heading", { level: 2, name: /^What.s new$/ })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Randomizer", "Stream tools", "Live"]);
  const first = screen.getAllByRole("article")[0];
  expect(within(first).getByRole("heading", { level: 4 }).textContent).toBe("Draw a build, your opening units, or both.");
  expect(CARDS[0].size).toBe("lead");
});

it("gives every card one availability label, a picture with alt text and a help link", () => {
  render(<WhatsNewShowcase />);
  const articles = screen.getAllByRole("article");
  expect(articles).toHaveLength(CARDS.length);
  articles.forEach((article, index) => {
    const card = CARDS[index];
    expect(within(article).getAllByRole("img")).toHaveLength(1);
    expect(within(article).getByRole("img").getAttribute("alt")).toBe(card.image.alt);
    expect(within(article).getByRole("link").getAttribute("href")).toBe(card.link.href);
    expect(article.textContent).toMatch(/Live now|Desktop app 0\.26\.0|Coming soon/);
  });
});

it("never presents a gated feature as live", () => {
  const live = CARDS.find((card) => card.id === "live-streams");
  expect(live?.availability).toBe("soon");
  const chapters = CARDS.find((card) => card.id === "game-chapters");
  expect(chapters?.note).toMatch(/YouTube.*coming soon/);
  const { container } = render(<WhatsNewShowcase />);
  const liveCard = container.querySelector("#live-streams-title")!.closest("article")!;
  expect(liveCard.textContent).toContain("Coming soon");
  expect(liveCard.textContent).not.toContain("Live now");
});

it("marks every desktop-only card with the release that carries it", () => {
  const desktop = CARDS.filter((card) => card.availability === "desktop");
  expect(desktop.map((card) => card.id)).toEqual(["randomizer-loading-card", "stream-tags", "stream-guardian"]);
  const { container } = render(<WhatsNewShowcase />);
  for (const card of desktop) {
    expect(container.querySelector(`#${card.id}-title`)!.closest("article")!.textContent).toContain("Desktop app 0.26.0");
  }
});

it("ships small pictures whose declared size is the file's real size", () => {
  for (const { image } of CARDS) {
    const file = path.join(PUBLIC_DIR, image.src);
    const bytes = readFileSync(file);
    // PNG header: 8-byte signature, then the IHDR chunk with width and height.
    expect(bytes.readUInt32BE(16), image.src).toBe(image.width);
    expect(bytes.readUInt32BE(20), image.src).toBe(image.height);
    expect(statSync(file).size, image.src).toBeLessThan(200 * 1024);
    expect(image.alt.length, image.src).toBeGreaterThan(30);
  }
});
