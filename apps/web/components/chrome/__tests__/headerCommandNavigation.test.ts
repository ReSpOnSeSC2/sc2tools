import { describe, expect, it } from "vitest";
import { signedInCommandNavigation } from "../headerCommandNavigation";
import { NAV_ENTRIES } from "../appNav";

describe("signedInCommandNavigation", () => {
  it("lists the app's own destinations with their keys, descriptions and gates, plus Help", () => {
    const rows = signedInCommandNavigation({ isAdmin: false, reviews: true, guides: true });
    const navKeys = new Set(NAV_ENTRIES.map((entry) => entry.key));
    expect(rows[0]).toMatchObject({ key: "today", href: "/app" });
    expect(rows.every((row) => navKeys.has(row.key) || row.key === "help")).toBe(true);
    expect(rows.every((row) => typeof row.description === "string" && row.description.length > 0)).toBe(true);
    expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining(["opponents", "sessions", "builds-library", "settings"]));
    // No role probe on the marketing header: Coaching fails closed; Admin needs /v1/me.
    expect(rows.some((row) => row.key === "coaching" || row.key === "admin")).toBe(false);
    expect(rows.at(-1)).toEqual({ key: "help", href: "/help", label: "Help", description: "Articles for every feature" });
    expect(signedInCommandNavigation({ isAdmin: true, reviews: true, guides: true }).some((row) => row.key === "admin")).toBe(true);
    expect(signedInCommandNavigation({ isAdmin: false, reviews: false, guides: false }).some((row) => row.key === "reviews" || row.key === "guides")).toBe(false);
  });
});
