import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ReportCardPage, { dynamicParams, generateStaticParams, metadata } from "./page";

vi.mock("@/components/instant/ReportCardViewer", () => ({ ReportCardViewer: () => <p>Card viewer</p> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));

const segments = { type: "report", class: "summary" };

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("prerenders only the supported enum pair and disallows indexing", async () => {
  expect(generateStaticParams()).toEqual([segments]);
  expect(dynamicParams).toBe(false);
  expect(metadata.robots).toMatchObject({ index: false });
  await expect(ReportCardPage({ params: Promise.resolve({ ...segments, class: "arbitrary" }) })).rejects.toThrow("Not found");
});

it.each([
  ["all", "Make yours", "/try"],
  ["off", "Explore SC2 Tools", "/"],
])("keeps the public viewer usable with Instant Analysis set to %s", async (mode, name, href) => {
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", mode);
  render(await ReportCardPage({ params: Promise.resolve(segments) }));
  expect(screen.getByText(/numbers are self-reported/)).toBeTruthy();
  expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
});
