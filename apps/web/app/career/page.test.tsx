import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/components/career/Career", () => ({ Career: () => <p>Career tool</p> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
import CareerPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("shows the local career tool when Instant Analysis is public", () => {
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
  render(<CareerPage />);
  expect(screen.getByRole("heading", { name: "Your StarCraft II career" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "How your replay record works" }).getAttribute("href")).toBe("/help/replay-career");
  expect(screen.getByText("Career tool")).toBeTruthy();
});

it.each(["off", "admins", ""])("returns 404 when rollout is %j", (mode) => {
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", mode);
  expect(() => CareerPage()).toThrow("Not found");
});
