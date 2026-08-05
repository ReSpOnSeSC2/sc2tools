import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import OverlayLayout from "@/app/overlay/layout";

afterEach(cleanup);

describe("OverlayLayout transparency", () => {
  it("removes the site's body backdrop from OBS browser sources", () => {
    const { container } = render(
      <OverlayLayout>
        <div>overlay</div>
      </OverlayLayout>,
    );
    const css = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent)
      .join("\n");

    expect(css).toContain("body::before");
    expect(css).toMatch(/body::before\s*\{[^}]*display:\s*none\s*!important/s);
  });
});
