import { expect, type Page, type TestInfo } from "@playwright/test";

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** Serialized into the browser with all runtime dependencies kept inside it. */
function measureRaceLabels() {
  const parse = (value: string): Rgba => {
    if (!/^rgba?\(/.test(value) || value.includes("%")) throw new Error(`Unsupported color ${value}`);
    const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
    if (channels.length !== 3 && channels.length !== 4) throw new Error(`Invalid color ${value}`);
    return [channels[0], channels[1], channels[2], channels[3] ?? 1];
  };
  const over = (front: Rgba, back: Rgb): Rgb => front.slice(0, 3).map((channel, index) =>
    channel * front[3] + back[index] * (1 - front[3])) as Rgb;
  const luminance = (rgb: Rgb) => rgb.map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = (node: Element) => {
    const ancestors: Element[] = [];
    for (let current: Element | null = node; current; current = current.parentElement) ancestors.push(current);
    let color: Rgb | null = null;
    const layers: Array<{ tag: string; color: string }> = [];
    for (const ancestor of ancestors.reverse()) {
      const style = getComputedStyle(ancestor);
      if (style.backgroundImage !== "none" || Number(style.opacity) !== 1) {
        throw new Error("Unexpected image or opacity needs manual background disposition");
      }
      const paint = parse(style.backgroundColor);
      layers.push({ tag: ancestor.tagName, color: style.backgroundColor });
      if (paint[3] === 1) color = paint.slice(0, 3) as Rgb;
      else if (color) color = over(paint, color);
    }
    if (!color) throw new Error("No actual opaque CSS backdrop establishes the race-label background");
    return { color, layers };
  };
  return [...document.querySelectorAll<HTMLElement>('span[title^="Opponent race"]')].flatMap(tag => {
    const box = tag.getBoundingClientRect(), css = getComputedStyle(tag);
    if (!box.width || !box.height || css.visibility !== "visible") return [];
    const letter = tag.querySelector<HTMLElement>("span.font-mono");
    if (!letter) throw new Error("Race letter missing");
    const foreground = getComputedStyle(letter).color, backdrop = background(letter);
    const ink = over(parse(foreground), backdrop.color), first = luminance(ink), second = luminance(backdrop.color);
    return [{ title: tag.title, letter: letter.textContent, foreground, effectiveBackground: backdrop.color,
      backgroundLayers: backdrop.layers, ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      branch: tag.closest("table") ? "desktop" : "mobile", fontSize: getComputedStyle(letter).fontSize }];
  });
}

async function captureRaceContrast(page: Page, info: TestInfo, phase: string) {
  const measured = await page.evaluate(measureRaceLabels);
  await info.attach(`race-label-contrast-${phase}`, {
    contentType: "application/json", body: JSON.stringify(measured),
  });
  expect(measured).toHaveLength(6);
  expect(measured.map(row => `${row.letter}|${row.title}`).sort()).toEqual([
    "?|Opponent race not recorded for this game", "P|Opponent race: Protoss", "R|Opponent race: Random",
    "T|Opponent race: Terran", "T|Opponent race: Terran (inferred from strategy name)", "Z|Opponent race: Zerg",
  ].sort());
  const branch = page.viewportSize()!.width < 768 ? "mobile" : "desktop";
  expect(new Set(measured.map(row => row.branch))).toEqual(new Set([branch]));
  for (const row of measured) expect(row.ratio, `${row.title}: ${row.foreground}`).toBeGreaterThanOrEqual(4.5);
}

export async function checkRaceLabelContrast(page: Page, info: TestInfo) {
  const unknown = page.locator('span[title="Opponent race not recorded for this game"]:visible');
  await expect(unknown).toHaveText("?");
  await expect(unknown.locator('img,svg,[role="img"]')).toHaveCount(0);
  await captureRaceContrast(page, info, "normal");
  if (page.viewportSize()!.width >= 768) {
    const tags = page.locator('span[title^="Opponent race"]:visible');
    await expect(tags).toHaveCount(6);
    for (let index = 0; index < 6; index++) {
      await tags.nth(index).hover();
      await captureRaceContrast(page, info, `hover-${index}`);
    }
  }
}
