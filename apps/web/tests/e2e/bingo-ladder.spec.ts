import { expect, test, type Page } from "@playwright/test";
import { checkAccessibility } from "./accessibility-check";
import { openBingoLadderFixture } from "./bingo-ladder-fixture.mjs";

type BingoWindow = typeof window & {
  bingoFixtureLabels: string[];
  bingoFixtureMutations: string[];
  bingoFixtureCards: Array<{ cells: Array<{ label: string }> }>;
};

async function cardGeometry(page: Page) {
  return page.getByRole("grid", { name: "Bingo card", exact: true }).evaluate(grid => {
    const cells = Array.from(grid.querySelectorAll<HTMLElement>('[role="gridcell"]'));
    const rects = cells.map(cell => cell.getBoundingClientRect());
    const failures: Array<{ label: string; issue: string }> = [];
    for (const [index, cell] of cells.entries()) {
      const label = cell.textContent?.trim() ?? "", box = rects[index], span = cell.querySelector("span");
      if (label !== cell.getAttribute("aria-label")) failures.push({ label, issue: "visible objective differs from accessible name" });
      if (!span || !label) { failures.push({ label, issue: "missing full objective" }); continue; }
      const style = getComputedStyle(span);
      if (style.overflow === "hidden" || style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") failures.push({ label, issue: "objective is clipped or truncated" });
      const range = document.createRange(); range.selectNodeContents(span);
      for (const line of Array.from(range.getClientRects())) {
        if (line.left < box.left + 0.5 || line.right > box.right - 0.5 || line.top < box.top + 0.5 || line.bottom > box.bottom - 0.5) {
          failures.push({ label, issue: "rendered text escapes its tile border" }); break;
        }
      }
      if (cell.scrollWidth > cell.clientWidth + 1 || cell.scrollHeight > cell.clientHeight + 1) failures.push({ label, issue: "tile content overflows" });
      if (index % 5 !== 0 && box.left < rects[index - 1].right) failures.push({ label, issue: "adjacent tiles overlap" });
      if (index >= 5 && box.top < rects[index - 5].bottom) failures.push({ label, issue: "rows overlap" });
    }
    return {
      failures, labels: cells.map(cell => cell.textContent?.trim() ?? ""),
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      rowStarts: rects.filter((_, index) => index % 5 === 0).map(box => box.top),
      firstRow: rects.slice(0, 5).map(box => ({ top: box.top, width: box.width, height: box.height })),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Bingo ${theme}: every complete objective stays inside its tile with enlarged text`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const evidence = await openBingoLadderFixture(page, { theme });
    const candidates = await page.evaluate(() => (window as BingoWindow).bingoFixtureLabels);
    expect(candidates).toContain("Beat a player who built a Battlecruiser");
    expect(candidates).toContain("Win a game with a Mothership");
    const count = await page.evaluate(() => (window as BingoWindow).bingoFixtureCards.length);
    const widths = info.project.name === "mobile-360" ? [320, 390] : [info.project.name === "tablet-768" ? 768 : 1280];
    const observations = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const scale of [1, 2]) {
        const seen = new Set<string>();
        for (let card = 0; card < count; card++) {
          // Each specimen mounts the actual mode with that persisted card.
          // An invented selector/store lifecycle must not stand in for coverage.
          await evidence.showCard(card, scale);
          const expectedLabels = await page.evaluate(index => (window as BingoWindow).bingoFixtureCards[index].cells.map(cell => cell.label), card);
          await expect(page.getByRole("gridcell")).toHaveText(expectedLabels);
          const geometry = await cardGeometry(page);
          expect(geometry.labels).toHaveLength(25);
          geometry.labels.forEach(label => seen.add(label));
          expect(geometry.columns).toBe(5);
          expect(geometry.rowStarts).toHaveLength(5);
          expect(new Set(geometry.firstRow.map(box => box.top)).size).toBe(1);
          expect(Math.max(...geometry.firstRow.map(box => box.width)) - Math.min(...geometry.firstRow.map(box => box.width))).toBeLessThanOrEqual(1);
          expect(geometry.failures, `${width}px, ${scale * 100}% text, card ${card + 1}`).toEqual([]);
          expect(geometry.horizontalOverflow, `${width}px, ${scale * 100}% text`).toBe(false);
          expect(await page.evaluate(() => (window as BingoWindow).bingoFixtureMutations)).toEqual([]);
          observations.push({ width, scale, card, ...geometry });
        }
        expect(candidates.every(label => seen.has(label))).toBe(true);
        await evidence.showCard(0, scale);
        const firstLabels = await page.evaluate(() => (window as BingoWindow).bingoFixtureCards[0].cells.map(cell => cell.label));
        await expect(page.getByRole("gridcell")).toHaveText(firstLabels);
        await checkAccessibility(page, info, `/bingo-ladder-${width}-${scale}`, theme);
        if (scale === 1) await info.attach(`bingo-${theme}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      }
    }
    expect(evidence.errors).toEqual([]); expect(evidence.unexpectedRequests).toEqual([]);
    expect(await page.evaluate(() => (window as BingoWindow).bingoFixtureMutations)).toEqual([]);
    await info.attach("bingo-layout-and-boundaries", { body: JSON.stringify({ candidates, observations, errors: evidence.errors, unexpectedRequests: evidence.unexpectedRequests }), contentType: "application/json" });
  });
}
