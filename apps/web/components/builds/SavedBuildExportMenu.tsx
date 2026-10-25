"use client";

import { coerceSavedRules } from "@/lib/build-rules";
import type { BuildExportMeta, ExportStep } from "@/lib/gameExport";
import { BuildExportMenu } from "./BuildExportMenu";
import { readReferenceBuildOrder } from "@/lib/buildOrderReference";

/** A saved definition's deadlines are never presented as recorded production. */
export function SavedBuildExportMenu({ build, meta }: { build: object; meta: BuildExportMeta }) {
  const source = build as Record<string, unknown>, rules = coerceSavedRules(source.rules);
  const reference = readReferenceBuildOrder(source.buildOrder);
  if (reference?.steps.length) return <BuildExportMenu steps={[]} reference={reference} meta={meta} />;
  const steps: ExportStep[] = [];
  let deadlines = false;
  if (!rules.length && Array.isArray(source.signature)) {
    deadlines = true;
    for (const item of source.signature) {
      if (!item || typeof item.unit !== "string" || !Number.isFinite(item.beforeSec) || item.beforeSec < 0) continue;
      steps.push({ time: item.beforeSec, name: item.unit, count: Number.isFinite(item.count) ? Math.max(1, Math.floor(item.count)) : 1 });
    }
  } else if (!rules.length && Array.isArray(source.steps)) {
    for (const item of source.steps) {
      if (!item || typeof item.action !== "string") continue;
      const match = typeof item.time === "string" ? /^(\d+):([0-5]\d)$/.exec(item.time.trim()) : null;
      const time = match ? Number(match[1]) * 60 + Number(match[2]) : typeof item.time === "number" ? item.time : NaN;
      if (!Number.isFinite(time) || time < 0) continue;
      steps.push({ time, name: item.action, ...(typeof item.supply === "number" && Number.isFinite(item.supply) && item.supply >= 0 ? { supply: item.supply } : {}) });
    }
  }
  if (!steps.length && !rules.length) return null;
  return <BuildExportMenu steps={steps} rules={rules} meta={{ ...meta, timing: deadlines ? "deadlines" : undefined }} />;
}
