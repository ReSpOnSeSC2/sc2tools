import { beforeEach, expect, it, vi } from "vitest";
import CompareRoute from "./page";

const h = vi.hoisted(() => ({ fetch: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.fetch }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/components/analyzer/compare/CompareGamesPage", () => ({ CompareGamesPage: () => null }));

const A = "r-" + "a".repeat(24);
const B = "r-" + "b".repeat(24);
const legacy = "date|Private Rival|Map";

beforeEach(() => {
  vi.clearAllMocks();
  h.redirect.mockImplementation(() => { throw new Error("redirect"); });
});

it("renders a canonical pair without trying to resolve raw IDs", async () => {
  const page = await CompareRoute({ searchParams: Promise.resolve({ a: A, b: B }) });
  expect(page.props).toEqual({ a: A, b: B });
  expect(h.fetch).not.toHaveBeenCalled();
});

it("converts an authenticated legacy bookmark and preserves side order", async () => {
  h.fetch.mockResolvedValue({ ok: true, data: { references: [A] } });
  await expect(CompareRoute({ searchParams: Promise.resolve({ a: legacy, b: B }) })).rejects.toThrow("redirect");
  expect(h.fetch).toHaveBeenCalledWith("/v1/compare-games/references", { method: "POST", body: JSON.stringify({ gameIds: [legacy] }) });
  expect(h.redirect).toHaveBeenCalledWith("/app/compare?a=" + A + "&b=" + B);
});

it("leaves a legacy bookmark retryable through a temporary API outage", async () => {
  h.fetch.mockResolvedValue({ ok: false, status: 503 });
  await expect(CompareRoute({ searchParams: Promise.resolve({ a: legacy, b: B }) })).rejects.toThrow("Couldn't open");
  expect(h.redirect).not.toHaveBeenCalled();
});

it("removes a malformed legacy input before rendering", async () => {
  await expect(CompareRoute({ searchParams: Promise.resolve({ a: "x".repeat(201), b: B }) })).rejects.toThrow("redirect");
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.redirect).toHaveBeenCalledWith("/app/compare?b=" + B);
});

it("removes a legacy input no longer in the owner's history", async () => {
  h.fetch.mockResolvedValue({ ok: true, data: { references: [null] } });
  await expect(CompareRoute({ searchParams: Promise.resolve({ a: legacy, b: B }) })).rejects.toThrow("redirect");
  expect(h.redirect).toHaveBeenCalledWith("/app/compare?b=" + B);
});
