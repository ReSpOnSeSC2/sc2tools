export function shareLabel(count: number, total: number): string {
  const share = total > 0 ? Math.max(0, count / total * 100) : 0;
  return `${share > 0 && share < 1 ? share.toFixed(1) : Math.round(share)}%`;
}

export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, rows: unknown[][]): void {
  const url = URL.createObjectURL(new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function publicPageHref(path: string): string | null {
  return /^\/(?!\/)/.test(path) && !/[?\\\r\n]/.test(path)
    ? `https://sc2tools.com${path}` : null;
}

export function validateDateRange(from: string, to: string, today: string): string | null {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to)) return "Enter both dates.";
  if (from > to) return "From must be on or before To.";
  if (to > today) return "To cannot be after today.";
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > 365) return "Choose at most 365 days.";
  return null;
}
