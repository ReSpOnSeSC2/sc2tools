import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import StatusPage, { metadata } from "./page";

it("renders public canonical status content without inventing SSR health or making server requests", () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  try {
    const html = renderToString(<StatusPage />);
    expect(html).toContain("System status");
    expect(html.match(/>Unknown</g)).toHaveLength(2);
    expect(html).toContain("Not checked yet.");
    expect(html).toContain("Enable JavaScript to run these browser reachability checks");
    expect(html).toContain('href="/help"'); expect(html).toContain('href="/"');
    expect(metadata.alternates?.canonical).toBe("/status");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
