import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/components/wrapped/YearRecap", () => ({ YearRecap: () => <p>Recap tool</p> }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
import YearRecapPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it("shows the local tool only when Instant Analysis is public", () => {
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
  render(<YearRecapPage />);
  expect(screen.getByRole("heading", { name: "Your 2026 in StarCraft II" })).toBeTruthy();
  expect(screen.getByText("Recap tool")).toBeTruthy();
});

it.each(["off", "admins", ""])("returns 404 when rollout is %j", (mode) => {
  vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", mode);
  expect(() => YearRecapPage()).toThrow("Not found");
});
