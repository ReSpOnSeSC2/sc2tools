import { Icon } from "@/components/ui/Icon";
import { signatureToRows, type BuildSignatureItem } from "@/lib/build-events";
import type { CustomBuild } from "@/components/builds/types";
import { humanizeRuleEntity } from "@/lib/build-rules-copy";

/** Positive deadlines only: absence/upper-bound rules never become build steps. */
export function KeySteps({ build }: { build?: Partial<CustomBuild> }) {
  const signature: BuildSignatureItem[] = build?.signature?.length ? build.signature : (build?.rules ?? [])
    .filter((rule) => rule.type === "before" || ((rule.type === "count_min" || rule.type === "count_exact") && rule.count > 0))
    .map((rule) => ({ unit: rule.name, beforeSec: rule.time_lt, count: "count" in rule ? rule.count : 1 }));
  const steps = signatureToRows(signature).sort((a, b) => a.time - b.time).slice(0, 5);
  if (!steps.length) return null;
  return <ul aria-label="Key build steps" className="flex flex-wrap gap-x-3 gap-y-2">
    {steps.map((step) => <li key={step.key} title={`${humanizeRuleEntity(step.rawName)} before ${step.timeDisplay}`} className="inline-flex items-center gap-1 text-micro text-text-muted">
      {step.iconName ? <Icon name={step.iconName} kind={step.iconKind ?? undefined} size={20} decorative /> : <span aria-hidden className="rounded bg-bg-elevated px-1">{step.displayName.slice(0, 2)}</span>}
      <span className="sr-only">{humanizeRuleEntity(step.rawName)} before </span><span className="font-mono tabular-nums">{step.timeDisplay}</span>
    </li>)}
  </ul>;
}
