import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useDocumentTitle } from "../useDocumentTitle";
import { siteTitle } from "../siteTitle";

function Titled({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

beforeEach(() => {
  document.title = "Settings · SC2 Tools";
});
afterEach(cleanup);

describe("siteTitle", () => {
  it("formats like the root title template", () => {
    expect(siteTitle("Overlay · Settings")).toBe("Overlay · Settings · SC2 Tools");
  });
});

describe("useDocumentTitle", () => {
  it("names the tab and follows changes", () => {
    const view = render(<Titled title="Overlay · Settings" />);
    expect(document.title).toBe("Overlay · Settings · SC2 Tools");
    view.rerender(<Titled title="Voice · Settings" />);
    expect(document.title).toBe("Voice · Settings · SC2 Tools");
  });

  it("restores the route's title on unmount", () => {
    const view = render(<Titled title="Voice · Settings" />);
    view.unmount();
    expect(document.title).toBe("Settings · SC2 Tools");
  });

  it("keeps a newer title that something else set (a navigation)", () => {
    const view = render(<Titled title="Voice · Settings" />);
    document.title = "Today · SC2 Tools";
    view.unmount();
    expect(document.title).toBe("Today · SC2 Tools");
  });

  it("leaves the title alone when given nothing", () => {
    render(<Titled title={null} />);
    expect(document.title).toBe("Settings · SC2 Tools");
  });
});
