import { describe, expect, it } from "vitest";
import { currentCoverage, recurringDonationUrl } from "@/lib/donationCoverage";

describe("donation coverage", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const row = { month: "2026-11", receivedUsd: 41, supporterCount: 3, updatedAt: now.toISOString() };
  it("shows the latest verified totals for 45 days", () => {
    expect(currentCoverage(row, 78, now)).toMatchObject({ monthLabel: "November 2026", percent: 53, covered: false });
    expect(currentCoverage(row, 40, now)).toMatchObject({ percent: 100, covered: true });
    expect(currentCoverage({ ...row, month: "2026-09", updatedAt: "2026-09-20" }, 78, now)).toBeNull();
    expect(currentCoverage({ ...row, month: "2026-12" }, 78, now)).toBeNull();
  });

  it("shows the recurring link only for configured HTTPS donation destinations", () => {
    expect(recurringDonationUrl(undefined)).toBeNull();
    expect(recurringDonationUrl("https://github.com/sponsors/example")).toBe("https://github.com/sponsors/example");
    expect(recurringDonationUrl("https://github.com/example")).toBeNull();
    expect(recurringDonationUrl("http://ko-fi.com/example")).toBeNull();
    expect(recurringDonationUrl("https://paypal.com.example.test/")).toBeNull();
  });
});
