import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LOGO_MARK_SRC, LogoMark } from "../LogoMark";

afterEach(cleanup);

const WEB = process.cwd();
const CHROME_FILES = ["AppChrome.tsx", "Header.tsx", "Footer.tsx", "MobileNav.tsx"].map((file) =>
  path.join(WEB, "components/chrome", file),
);

describe("LogoMark", () => {
  it("serves the small WebP straight, without the image optimizer", () => {
    const { container } = render(<LogoMark size={30} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/logo-64.webp");
    expect(img?.getAttribute("width")).toBe("30");
    expect(img?.getAttribute("height")).toBe("30");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.className).toContain("rounded-full");
  });

  it("is a few kilobytes, not the 2 MB original", () => {
    const file = path.join(WEB, "public", LOGO_MARK_SRC);
    expect(statSync(file).size).toBeLessThan(16 * 1024);
    // RIFF....WEBP
    const header = readFileSync(file).subarray(0, 12).toString("latin1");
    expect(header.startsWith("RIFF") && header.endsWith("WEBP")).toBe(true);
  });

  it("is what the site and app chrome use", () => {
    for (const file of CHROME_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("/logo.png");
      expect(source, file).toContain("<LogoMark");
    }
  });
});
