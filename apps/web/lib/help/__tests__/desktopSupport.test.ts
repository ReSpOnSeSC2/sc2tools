import { describe, expect, it } from "vitest";
import article from "../articles/desktop-app/desktop-app-support";

describe("desktop support guide", () => {
  it("explains native availability, deliberate checks and reviewed local bytes", () => {
    const text = JSON.stringify(article.body);
    expect(article.slug).toBe("desktop-app-support");
    expect(text).toContain("published 0.24.7");
    expect(text).toContain("Help > Copy support info");
    expect(text).toContain("exactly the reviewed bytes");
    expect(text).toContain("Existing files are not overwritten");
    expect(text).toContain("never sent automatically");
    expect(text).not.toContain("attach a screenshot");
  });
});
