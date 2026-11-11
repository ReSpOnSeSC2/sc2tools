"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Popover } from "@/components/ui/Popover";
import type { InstantReport } from "@/lib/instant/report";
import { downloadGamesCsv, reportSummaryText } from "@/lib/instant/reportExport";
import type { ReportFilters } from "@/lib/instant/reportFilters";

export function ReportExportMenu({ report, filters }: { report: InstantReport; filters: ReportFilters }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  return <>
    <Button ref={anchor} variant="secondary" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>Export</Button>
    <Popover id={id} label="Export report" open={open} onClose={() => setOpen(false)} anchorRef={anchor}>
      <div className="flex flex-col items-start gap-2">
        <Button variant="secondary" onClick={() => { downloadGamesCsv(report.games); setOpen(false); }}>Download games (CSV)</Button>
        <CopyButton text={reportSummaryText(report, filters)} copiedLabel="Summary copied"
          successMessage="Summary copied" fallbackLabel="Report summary">Copy summary</CopyButton>
      </div>
    </Popover>
  </>;
}
