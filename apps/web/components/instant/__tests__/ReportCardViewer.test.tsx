import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { decodeReportComparison, encodeReportCard, encodeReportComparison, reportCardLink } from "@/lib/instant/reportCardLink";
import { REPORT_CARD_PATH, REPORT_COMPARE_PATH } from "@/lib/instant/reportCardRoute";
import { ReportCardViewer } from "../ReportCardViewer";

const draw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/instant/reportCard", () => ({ drawReportCard: draw }));

const model = { totals: { games: 5, wins: 4, losses: 1 }, matchups: [], opener: null, macro: null };
const fragment = encodeReportCard(model);

function setFragment(hash = "", path = REPORT_CARD_PATH) {
  window.history.replaceState(null, "", `${path}${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

afterEach(() => {
  cleanup();
  draw.mockReset();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("builds a comparison locally and restores focus from clipboard fallback", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
  setFragment(`#${fragment}`);
  render(<ReportCardViewer />);
  const field = screen.getByRole("textbox", { name: "Your replay report link" });
  const compare = screen.getByRole("button", { name: "Compare reports" });
  fireEvent.change(field, { target: { value: "PrivateName" } });
  fireEvent.click(compare);
  expect(screen.getByRole("alert").textContent).not.toContain("PrivateName");
  expect(document.activeElement).toBe(field);

  const own = { ...model, totals: { games: 7, wins: 3, losses: 2 } };
  fireEvent.change(field, { target: { value: reportCardLink(own) } });
  fireEvent.click(compare);
  const card = screen.getByRole("region", { name: "Replay report comparison" });
  expect(document.activeElement).toBe(card);
  expect(within(card).getByRole("heading", { name: "You versus them" })).toBeTruthy();
  expect(within(card).getByText("60%")).toBeTruthy();
  expect(within(card).getByText("80%")).toBeTruthy();

  const copy = within(card).getByRole("button", { name: "Copy comparison link" });
  fireEvent.click(copy);
  const manual = await screen.findByRole<HTMLInputElement>("textbox", { name: "Comparison link" });
  expect(manual.classList.contains("selection:bg-text")).toBe(true);
  expect(manual.classList.contains("selection:text-bg")).toBe(true);
  const link = new URL(manual.value);
  expect(link.pathname).toBe(REPORT_COMPARE_PATH);
  expect(decodeReportComparison(link.hash.slice(1))).toEqual({ first: own.totals, second: model.totals });
  expect(document.activeElement).toBe(manual);
  fireEvent.keyDown(manual, { key: "Escape" });
  expect(document.activeElement).toBe(copy);
  act(() => { setFragment(`#${encodeReportCard(own)}`); });
  expect(screen.queryByRole("region", { name: "Replay report comparison" })).toBeNull();
});

it("uses neutral labels on a comparison permalink and rejects a summary fragment there", () => {
  const paired = encodeReportComparison({ first: { games: 3, wins: 0, losses: 0 }, second: model.totals });
  setFragment(`#${paired}`, REPORT_COMPARE_PATH);
  render(<ReportCardViewer cardClass="compare" />);
  expect(screen.getByRole("heading", { name: "Report A" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Report B" })).toBeTruthy();
  expect(screen.getByText("No decided games")).toBeTruthy();
  act(() => { setFragment(`#${fragment}`, REPORT_COMPARE_PATH); });
  expect(screen.getByText("This report card link is invalid")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Report A" })).toBeNull();
});

it("explains the totals requirement when the shared card excludes totals", () => {
  const selected = encodeReportCard({ ...model, totals: null, macro: { score: 68, games: 4 } });
  setFragment(`#${selected}`);
  render(<ReportCardViewer />);
  expect(screen.getByText("A comparison needs game totals in both links.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Compare reports" })).toBeNull();
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
