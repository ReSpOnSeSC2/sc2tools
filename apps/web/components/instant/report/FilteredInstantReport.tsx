"use client";

import { useMemo, useState } from "react";
import { buildInstantReport, type InstantPayload } from "@/lib/instant/report";
import { filterPayloads, isFiltered, loadReportFilters, presentOpponentRaces, saveReportFilters, type ReportFilters as Filters } from "@/lib/instant/reportFilters";
import { InstantReport, type InstantReportProps } from "../InstantReport";
import { ShareReportButton } from "../ShareReportButton";
import { ReportExportMenu } from "./ReportExportMenu";
import { ReportFilters } from "./ReportFilters";

export function FilteredInstantReport({ report, payloads, actions, ...props }: Omit<InstantReportProps, "controls" | "onMatchupChange"> & {
  payloads: readonly InstantPayload[];
}) {
  const [filters, setFilters] = useState(loadReportFilters);
  const races = useMemo(() => presentOpponentRaces(payloads), [payloads]);
  const visible = useMemo(() => {
    if (!isFiltered(filters)) return report;
    const now = new Date(report.asOf);
    return buildInstantReport(filterPayloads(payloads, filters, now), now);
  }, [filters, payloads, report]);
  const change = (next: Filters) => {
    setFilters(next);
    saveReportFilters(next);
  };
  return <InstantReport {...props} report={visible}
    controls={<ReportFilters value={filters} races={races} showing={visible.totals.games} total={report.totals.games} onChange={change} />}
    onMatchupChange={(matchup) => change({ ...filters, matchup })}
    actions={<>{actions}{visible.totals.games > 0 ? <>
      <ShareReportButton report={visible} filters={filters} />
      <ReportExportMenu report={visible} filters={filters} />
    </> : null}</>} />;
}
