import { describe, expect, it } from "vitest";
import { resolveBrollVideoFormat } from "../brollVideoFormat";

describe("resolveBrollVideoFormat", () => {
  it("chooses the source from viewport geometry", () => {
    expect(resolveBrollVideoFormat("", 1920, 1080)).toBe("horizontal");
    expect(resolveBrollVideoFormat("", 1080, 1920)).toBe("vertical");
  });

  it("honors an explicit orientation override", () => {
    expect(resolveBrollVideoFormat("?orientation=vertical", 1920, 1080)).toBe(
      "vertical",
    );
    expect(resolveBrollVideoFormat("?orientation=horizontal", 1080, 1920)).toBe(
      "horizontal",
    );
  });
});
