"use client";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/lib/csvExport";

export function TableCsvButton<Row extends object>({ section, rows, columns, scope, disabled = false }: {
  section: string; rows: readonly Row[]; columns: readonly CsvColumn<Row>[]; scope: string; disabled?: boolean;
}) {
  return <Button variant="ghost" size="sm" aria-label="Export these rows as CSV" disabled={disabled || !rows.length} onClick={() => {
    const exportedAt = new Date();
    downloadCsv(csvFilename(section, exportedAt), toCsv({ columns, rows, scope, exportedAt }));
  }}><Download className="mr-1 h-4 w-4" />{rows.length ? "Export CSV" : "Nothing to export"}</Button>;
}
