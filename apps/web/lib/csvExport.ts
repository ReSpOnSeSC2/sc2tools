export type CsvCell = string | number | boolean | null | undefined;
export type CsvColumn<Row> = { key: keyof Row | string; label: string; format?: (value: unknown, row: Row) => CsvCell };

/** RFC4180 cell quoting. Text receives the spreadsheet formula guard;
 * numeric values keep their type, so a measured -12 remains a number. */
export function csvCell(value: CsvCell): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Shared client-side table export. The scope and local export time travel
 * with the file; rendering windows never truncate the rows passed here. */
export function toCsv<Row extends object>({ columns, rows, scope, exportedAt = new Date() }: {
  columns: readonly CsvColumn<Row>[]; rows: readonly Row[]; scope: string; exportedAt?: Date;
}): string {
  const lines = [
    ["Scope", `${scope} · exported ${exportedAt.toLocaleString()}`].map(csvCell).join(","),
    "",
    columns.map(column => csvCell(column.label)).join(","),
    ...rows.map(row => columns.map(column => {
      const value = (row as Record<string, unknown>)[String(column.key)];
      return csvCell(column.format ? column.format(value, row) : value as CsvCell);
    }).join(",")),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}
