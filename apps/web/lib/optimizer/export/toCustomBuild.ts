/**
 * Convert an AdaptResult into the payload for the existing custom
 * builds API: PUT /v1/custom-builds/:slug (see BuildEditorSheet for
 * the canonical manual flow and apps/api validation/customBuild.js
 * for the accepted schema).
 */
import {
  eventsToSignature,
  formatBuildTime,
  normalizeBuildEvents,
  slugifyBuildName,
  type BuildSignatureItem,
} from "@/lib/build-events";
import type { Race, VsRace } from "@/lib/race";
import { buildOrderText } from "../sim/format";
import type { AdaptResult } from "../types";

export interface CustomBuildPayload {
  slug: string;
  name: string;
  race: Race;
  vsRace: VsRace;
  description?: string;
  notes?: string;
  isPublic: boolean;
  signature: BuildSignatureItem[];
  perspective: "you";
}

export function defaultBuildName(result: AdaptResult): string {
  return `${result.referenceName} (${result.profileId})`;
}

function describeSafety(result: AdaptResult): string {
  if (result.safety.threats.length === 0) {
    return "No threats selected.";
  }
  const lines = result.safety.threats.map((t) => {
    const margin = Math.round(t.worstMargin * 100);
    return `- ${t.threatName}: ${t.verdict} (worst margin ${margin >= 0 ? "+" : ""}${margin}%)`;
  });
  return lines.join("\n");
}

function describeShifts(result: AdaptResult): string {
  const rows = result.comparison.filter((r) => r.deltaSec !== undefined);
  if (rows.length === 0) return "(no comparable steps)";
  return rows
    .map((r) => {
      const from = formatBuildTime(r.baselineStartSec ?? 0);
      const to = formatBuildTime(r.adaptedStartSec ?? 0);
      const delta = r.deltaSec ?? 0;
      const sign = delta >= 0 ? "+" : "−";
      return `- ${r.name}: ${from} → ${to} (${sign}${Math.abs(Math.round(delta))}s)`;
    })
    .join("\n");
}

/**
 * Notes carry the full supply-stamped build order, the old-patch vs
 * new-patch timing shifts, and the safety summary — everything needed
 * to audit the adaptation later.
 */
export function buildNotes(result: AdaptResult): string {
  const sections = [
    `Adapted from "${result.referenceName}" (${result.baselineProfileId} → ${result.profileId}).`,
    "",
    "Build order:",
    buildOrderText(result.sim),
    "",
    `Timing shifts vs ${result.baselineProfileId}:`,
    describeShifts(result),
    "",
    "Safety report:",
    describeSafety(result),
    "",
    `Workers at ${formatBuildTime(result.sim.endTime)}: ${result.sim.finalWorkers}`,
  ];
  return sections.join("\n").slice(0, 8000);
}

export function toCustomBuildPayload(
  result: AdaptResult,
  options: {
    name: string;
    vsRace: VsRace;
    description?: string;
    isPublic?: boolean;
  },
): CustomBuildPayload {
  const slug = slugifyBuildName(options.name);
  // Reuse the exact signature-compression path manual builds use so
  // the agent's classifier sees identical shapes.
  const rows = normalizeBuildEvents(
    result.sim.steps
      .filter((s) => !["Probe", "SCV", "Drone"].includes(s.name))
      .map((s) => ({ time: Math.max(0, Math.round(s.startSec)), name: s.name })),
  );
  const signature = eventsToSignature(rows);
  return {
    slug,
    name: options.name.trim().slice(0, 120),
    race: result.sim.race,
    vsRace: options.vsRace,
    description: options.description?.trim().slice(0, 4000) || undefined,
    notes: buildNotes(result),
    isPublic: options.isPublic ?? false,
    signature,
    perspective: "you",
  };
}

export const CUSTOM_BUILD_PUT_PATH = (slug: string): string =>
  `/v1/custom-builds/${encodeURIComponent(slug)}`;
