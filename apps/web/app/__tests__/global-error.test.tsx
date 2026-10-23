import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "../global-error";
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("retries, reloads the document and copies the error reference", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reset = vi.fn(); const reload = vi.fn(); const writeText = vi.fn().mockResolvedValue(undefined);
  const actualWindow = window;
  vi.stubGlobal("window", new Proxy(actualWindow, { get(target, key) { return key === "location" ? { pathname: "/app", reload } : Reflect.get(target, key, target); } }));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<GlobalError error={Object.assign(new Error("broken"), { digest: "test-42" })} reset={reset} />, { container: document.documentElement, baseElement: document.documentElement });
  fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(reset).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Reload page" })); expect(reload).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Copy reference" })); await waitFor(() => expect(writeText).toHaveBeenCalledWith("test-42"));
  const report = new URL(screen.getByRole("link", { name: "Report this problem" }).getAttribute("href")!);
  expect(report.searchParams.get("body")?.split("\n").find((line) => line.startsWith("Page:"))).toBe("Page: /app");
});
it("ships an independent theme restore script and light/dark crash styles", () => {
  const html = renderToStaticMarkup(<GlobalError error={new Error("broken")} reset={vi.fn()} />);
  expect(html).toContain("sc2tools.theme"); expect(html).toContain("prefers-color-scheme:light"); expect(html).toContain('href="/"');
});
