/**
 * The first-unit defense verdict ("Defensible" / "Risky" / "Exposed")
 * from the adaptation guard: can the build field a combat unit before the
 * opponent's fastest standard pressure arrives?
 */
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { formatBuildTime, humanizeBuildName } from "@/lib/build-events";
import type { DefenseAssessment } from "@/lib/optimizer/types";

const STYLES = {
  safe: {
    wrap: "border-success/40 bg-success/10 text-text",
    icon: "text-success",
    Icon: ShieldCheck,
    label: "Defensible",
  },
  risky: {
    wrap: "border-warning/40 bg-warning/10 text-text",
    icon: "text-warning",
    Icon: ShieldAlert,
    label: "Risky",
  },
  unsafe: {
    wrap: "border-danger/40 bg-danger/10 text-text",
    icon: "text-danger",
    Icon: ShieldX,
    label: "Exposed",
  },
} as const;

export function DefenseVerdictBadge({
  defense,
}: {
  defense: DefenseAssessment;
}) {
  const style = STYLES[defense.verdict];
  const { Icon } = style;
  const pressure = `~${formatBuildTime(defense.arrivalSec)} ${defense.attacker} pressure`;
  const assumed = defense.matchupKnown ? "" : " (assumed vs Terran)";

  let detail: string;
  if (!defense.firstUnit) {
    detail = `no combat unit before the ${pressure}${assumed}.`;
  } else {
    const unit = humanizeBuildName(defense.firstUnit.name);
    const out = formatBuildTime(defense.firstUnit.doneSec);
    detail =
      defense.verdict === "safe"
        ? `first ${unit} out ${out}, in time for the ${pressure}${assumed}.`
        : `first ${unit} out ${out} — ~${defense.exposedSec}s past the ${pressure}${assumed}.`;
  }

  return (
    <div
      className={`flex items-start gap-2 rounded-lg border-2 p-2 text-caption ${style.wrap}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon}`} aria-hidden />
      <span>
        <span className="font-semibold">{style.label}</span> — {detail}
      </span>
    </div>
  );
}
