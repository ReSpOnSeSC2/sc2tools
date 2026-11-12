"use client";

import { useMemo, useState } from "react";
import { buildInstantReport, type InstantPayload } from "@/lib/instant/report";
import { commanderSavedRows, type CommanderRow } from "@/lib/instant/commanderEvidence";
import { buildCommanderProfile } from "@/lib/instant/commanderProfile";
import { filterPayloads, isFiltered, loadReportFilters, presentOpponentRaces, saveReportFilters, type ReportFilters as Filters } from "@/lib/instant/reportFilters";
import { InstantReport, type InstantReportProps } from "../InstantReport";
import { ShareReportButton } from "../ShareReportButton";
import { ReportExportMenu } from "./ReportExportMenu";
import { ReportFilters } from "./ReportFilters";
import { CommanderIdCard } from "./CommanderIdCard";

export function FilteredInstantReport({ report, payloads, actions, commanderRows, ...props }: Omit<InstantReportProps, "controls" | "onMatchupChange"> & {
  payloads: readonly InstantPayload[];
  commanderRows?: readonly CommanderRow[];
}) {
  const [filters, setFilters] = useState(loadReportFilters);
  const races = useMemo(() => presentOpponentRaces(payloads), [payloads]);
  const commander = useMemo(() => buildCommanderProfile(commanderRows ?? commanderSavedRows(payloads)), [commanderRows, payloads]);
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
    controls={<><ReportFilters value={filters} races={races} showing={visible.totals.games} total={report.totals.games} onChange={change} />
      <CommanderIdCard profile={commander} scanned={commanderRows !== undefined} /></>}
    onMatchupChange={(matchup) => change({ ...filters, matchup })}
    actions={<>{actions}{visible.totals.games > 0 ? <>
      <ShareReportButton report={visible} filters={filters} commanderCode={commander?.code} />
      <ReportExportMenu report={visible} filters={filters} />
    </> : null}</>} />;
}
