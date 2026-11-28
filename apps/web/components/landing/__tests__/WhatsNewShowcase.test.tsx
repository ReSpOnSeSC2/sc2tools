import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { getArticle, helpArticleAnchors } from "@/lib/help";
import { NEW_FEATURE_GROUPS } from "@/lib/landingNewFeatures";
import { ORPHAN_SPAN, PICTURE_SIZES, WhatsNewShowcase, isOrphan } from "../WhatsNewShowcase";

afterEach(cleanup);

const CARDS = NEW_FEATURE_GROUPS.flatMap((group) => group.cards);
const PUBLIC_DIR = path.join(__dirname, "../../../public");

it("groups the cards under short headings with the Randomizer lead first", () => {
  render(<WhatsNewShowcase />);
  expect(screen.getByRole("heading", { level: 2, name: /^What.s new$/ })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Randomizer", "Stream tools", "Live"]);
  const first = screen.getAllByRole("article")[0];
  expect(within(first).getByRole("heading", { level: 4 }).textContent).toBe("Draw a build, your opening units, or both.");
  expect(CARDS[0].size).toBe("feature");
});

it("gives every card one availability label, a picture with alt text and a help link", () => {
  render(<WhatsNewShowcase />);
  const articles = screen.getAllByRole("article");
  expect(articles).toHaveLength(CARDS.length);
  articles.forEach((article, index) => {
    const card = CARDS[index];
    const pictures = within(article).getAllByRole("img");
    expect(pictures).toHaveLength(card.image.dark ? 2 : 1);
    pictures.forEach((picture) => expect(picture.getAttribute("alt")).toBe(card.image.alt));
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
    for (const src of [image.src, image.dark].filter((file): file is string => Boolean(file))) {
      const file = path.join(PUBLIC_DIR, src);
      const bytes = readFileSync(file);
      // PNG header: 8-byte signature, then the IHDR chunk with width and height.
      expect(bytes.readUInt32BE(16), src).toBe(image.width);
      expect(bytes.readUInt32BE(20), src).toBe(image.height);
      expect(statSync(file).size, src).toBeLessThan(200 * 1024);
    }
    expect(image.alt.length, image.src).toBeGreaterThan(30);
  }
});

it("gives the web pictures a light and a dark render and leaves only the desktop app dark-only", () => {
  const darkOnly = CARDS.filter((card) => !card.image.dark).map((card) => card.id);
  expect(darkOnly).toEqual(["randomizer-loading-card", "stream-tags", "stream-guardian"]);
  const { container } = render(<WhatsNewShowcase />);
  for (const card of CARDS.filter((entry) => entry.image.dark)) {
    const images = container.querySelector(`#${card.id}-title`)!.closest("article")!.querySelectorAll("img");
    expect(images[0].className, card.id).toContain("hidden");
    expect(images[0].className, card.id).toContain("data-theme=light");
    expect(images[1].className, card.id).toContain("data-theme=light]_&]:hidden");
  }
});

it("tells next/image the slot each card's picture really fills", () => {
  const { container } = render(<WhatsNewShowcase />);
  for (const card of CARDS) {
    const img = container.querySelector(`#${card.id}-title`)!.closest("article")!.querySelector("img")!;
    expect(img.getAttribute("sizes"), card.id).toBe(PICTURE_SIZES[card.size]);
  }
  // The two-column feature and the full-width card each get their own slot, not a tile's.
  expect(PICTURE_SIZES.feature).toContain("352px");
  expect(PICTURE_SIZES.wide).toContain("640px");
  expect(PICTURE_SIZES.wide).not.toContain("50vw");
  expect(PICTURE_SIZES.feature).not.toContain("380px");
});

it("lets the last card of a three-column group take the tablet row, and nothing else", () => {
  const { container } = render(<WhatsNewShowcase />);
  const spanning = (id: string) => container.querySelector(`#${id}-title`)!.closest("li")!.className.includes(ORPHAN_SPAN);
  expect(CARDS.filter((card) => spanning(card.id)).map((card) => card.id)).toEqual(["game-chapters"]);
  const tools = NEW_FEATURE_GROUPS.find((group) => group.id === "stream-tools")!;
  expect(tools.cards.map((_, index) => isOrphan(tools, index))).toEqual([false, false, true]);
  const articleOf = (id: string) => container.querySelector(`#${id}-title`)!.closest("article")!;
  expect(articleOf("game-chapters").className).toContain("md:max-lg:grid-cols-2");
  expect(articleOf("stream-tags").className).not.toContain("md:max-lg:grid-cols-2");
});

it("points every help link at a real article and section, each card at its own", () => {
  const targets = new Set<string>();
  for (const { link } of CARDS) {
    const [pathname, anchor] = link.href.split("#");
    const article = getArticle(pathname.replace("/help/", ""));
    expect(article, link.href).toBeTruthy();
    if (anchor) expect(helpArticleAnchors(article!), link.href).toContain(anchor);
    targets.add(link.href);
  }
  expect(targets.size).toBe(CARDS.length);
  expect(CARDS.find((card) => card.id === "randomizer-loading-card")!.link.href).toBe("/help/randomizer#desktop-draw");
});

it("describes Stream Guardian's game warning as it fires, and the section as not all shipped", () => {
  const guardian = CARDS.find((card) => card.id === "stream-guardian")!;
  expect(guardian.text).toMatch(/neither streaming nor recording/);
  expect(guardian.text).not.toMatch(/OBS not streaming/);
  const { container } = render(<WhatsNewShowcase />);
  const section = container.querySelector("#whats-new")!;
  expect(section.textContent).not.toMatch(/Just shipped/);
  expect(section.querySelector("p")!.textContent).toBe("Latest releases");
  expect(section.textContent).toMatch(/live stream directory on its way/);
});

it("sets its headings on the design system's type scale", () => {
  const { container } = render(<WhatsNewShowcase />);
  const headings = [...container.querySelectorAll("h3, h4")];
  expect(headings).toHaveLength(NEW_FEATURE_GROUPS.length + CARDS.length);
  for (const heading of headings) {
    expect(heading.className.split(" ")).toContain(heading.tagName === "H3" ? "text-h3" : "text-h4");
    expect(heading.className).not.toMatch(/text-(xl|2xl)/);
  }
});

it("reserves each picture's frame from its file size and fades only the cut-off one", () => {
  const { container } = render(<WhatsNewShowcase />);
  for (const card of CARDS) {
    const article = container.querySelector(`#${card.id}-title`)!.closest("article")!;
    const frame = article.querySelector("img")!.parentElement as HTMLElement;
    expect(frame.style.aspectRatio.replace(/\s/g, ""), card.id).toBe(`${card.image.width}/${card.image.height}`);
    const faded = [...article.querySelectorAll("img")].every((img) => img.className.includes("mask-image"));
    expect(faded, card.id).toBe(card.id === "randomizer-draws");
  }
});
