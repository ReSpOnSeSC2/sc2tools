import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { encodeReportCard } from "@/lib/instant/reportCardLink";
import { REPORT_CARD_PATH } from "@/lib/instant/reportCardRoute";
import { ReportCardViewer } from "../ReportCardViewer";

const draw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/instant/reportCard", () => ({ drawReportCard: draw }));

const model = { totals: { games: 5, wins: 4, losses: 1 }, matchups: [], opener: null, macro: null };
const fragment = encodeReportCard(model);

function setFragment(hash = "") {
  window.history.replaceState(null, "", `${REPORT_CARD_PATH}${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

afterEach(() => {
  cleanup();
  draw.mockReset();
  window.history.replaceState(null, "", "/");
});

it("replaces a missing card with a report and clears it for an invalid hash", () => {
  setFragment();
  render(<ReportCardViewer />);
  expect(screen.getByText("No report card in this link")).toBeTruthy();
  act(() => { setFragment(`#${fragment}`); });
  expect(screen.getByText(/5 games, 4-1/)).toBeTruthy();
  const scope = "These numbers cover the games selected by the sharer.";
  expect(screen.getByText(scope)).toBeTruthy();
  expect(draw).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), model, scope);
  act(() => { setFragment("#Untrusted_Name"); });
  expect(screen.getByText("This report card link is invalid")).toBeTruthy();
  expect(screen.queryByText(/Untrusted_Name|5 games, 4-1/)).toBeNull();
});

it("keeps text readable when canvas is unavailable and restores focus after retry", () => {
  draw.mockImplementationOnce(() => { throw new Error("No canvas"); });
  setFragment(`#${fragment}`);
  render(<ReportCardViewer />);
  expect(screen.getByText(/5 games, 4-1/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try image again" }));
  expect(screen.queryByRole("button", { name: "Try image again" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Shared replay report" }));
});
