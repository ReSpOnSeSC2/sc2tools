import { describe, expect, it } from "vitest";
import { REPORT_SUBJECT_MAX, errorReportMailto, errorReportSubject } from "../errorReport";

describe("errorReportSubject", () => {
  it("names the page and carries the digest", () => {
    expect(errorReportSubject("/app/opponents/1-S2-1-99?tab=games", "1234567890")).toBe(
      "Error on /app/opponents/1-S2-1-99 (ref 1234567890)",
    );
    expect(errorReportSubject("/settings")).toBe("Error on /settings");
  });

  it("never leaks a browser-source token", () => {
    expect(errorReportSubject("/overlay/secret-token/widget/scout", "99")).toBe(
      "Error on /overlay/[redacted]/widget/scout (ref 99)",
    );
  });

  it("shortens a long path so the reference still fits", () => {
    const subject = errorReportSubject(`/builds/${"x".repeat(300)}`, "digest-42");
    expect(subject.length).toBeLessThanOrEqual(REPORT_SUBJECT_MAX);
    expect(subject.endsWith("… (ref digest-42)")).toBe(true);
  });
});

describe("errorReportMailto", () => {
  it("mails support with the digest in the subject and body", () => {
    const href = errorReportMailto({ digest: "abc123" });
    expect(href.startsWith("mailto:responsecoaching@gmail.com?subject=")).toBe(true);
    const url = new URL(href);
    expect(url.searchParams.get("subject")).toBe("SC2 Tools error (ref abc123)");
    expect(url.searchParams.get("body")).toContain("Error reference: abc123");
  });

  it("adds the page when it is known", () => {
    const url = new URL(errorReportMailto({ pathname: "/app/macro?x=1", digest: "d1" }));
    expect(url.searchParams.get("subject")).toBe("Error on /app/macro (ref d1)");
    expect(url.searchParams.get("body")).toContain("Page: /app/macro");
  });
});
