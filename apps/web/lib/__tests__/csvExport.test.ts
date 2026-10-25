import { afterEach, describe, expect, it, vi } from "vitest";
import { csvCell, downloadCsv, toCsv } from "../csvExport";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("table CSV serialization", () => {
  it.each([['a,b', '"a,b"'], ['say "hi"', '"say ""hi"""'], ['two\nlines', '"two\nlines"'], ['two\r\nlines', '"two\r\nlines"']])("quotes %j without losing cell content", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
  it.each(["=SUM(A1)", "+cmd", "-12", "@name", "\tformula", "\rformula"])("guards spreadsheet text %j", value => {
    expect(csvCell(value)).toContain(`'${value}`);
  });
  it("does not apply the text guard to negative numeric MMR or raw fractions", () => {
    expect(csvCell(-12)).toBe("-12"); expect(csvCell(.583)).toBe("0.583"); expect(csvCell(null)).toBe(""); expect(csvCell(NaN)).toBe("");
  });
  it("writes BOM, scope, blank row, configured headers and all supplied rows with CRLF", () => {
    const rows = Array.from({ length: 1500 }, (_, index) => ({ name: index === 0 ? "=name" : `Opponent ${index}`, net: -12, ratio: .583 }));
    const csv = toCsv({ columns: [{ key: "name", label: "Name" }, { key: "net", label: "Net MMR" }, { key: "ratio", label: "WR" }], rows, scope: "Ranked 1v1 · Protoss", exportedAt: new Date("2026-10-25T12:00:00Z") });
    expect(csv.startsWith("\uFEFFScope,")).toBe(true); expect(csv).toContain("Ranked 1v1 · Protoss · exported");
    expect(csv).toContain("\r\n\r\nName,Net MMR,WR\r\n'=name,-12,0.583\r\n");
    expect(csv).toContain("Opponent 1499,-12,0.583\r\n"); expect(csv.split("\r\n")).toHaveLength(1504);
    expect(csv.replaceAll("\r\n", "")).not.toContain("\n");
  });
  it("allows a column to format a value using its complete row", () => {
    const csv = toCsv({ columns: [{ key: "ids", label: "Merged accounts", format: (_value, row: { ids: string[] }) => row.ids.join("; ") }], rows: [{ ids: ["a", "b"] }], scope: "All time" });
    expect(csv).toContain("\r\na; b\r\n");
  });
});

it("downloads one Blob with its exact filename and revokes the temporary object URL", async () => {
  vi.useFakeTimers(); const create = vi.fn((_blob: Blob) => "blob:local-csv"), revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  let clicked: HTMLAnchorElement | null = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked = this; });
  downloadCsv("sc2tools-opponents-all-time.csv", "\uFEFFName\r\nExample\r\n");
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(clicked!.download).toBe("sc2tools-opponents-all-time.csv"); expect(clicked!.href).toBe("blob:local-csv");
  expect(document.querySelector('a[download]')).toBeNull(); expect(revoke).not.toHaveBeenCalled();
  await vi.runAllTimersAsync(); expect(revoke).toHaveBeenCalledWith("blob:local-csv");
});
