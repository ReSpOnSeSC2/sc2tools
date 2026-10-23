import { useId } from "react";
import { Ban, CircleCheck, Gauge, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { RulesLegend } from "@/components/builds/editor/BuildEditorRulesHelp";
import { normalizeBuildName } from "@/lib/build-events";
import type { BuildRule } from "@/lib/build-rules";
import {
  RULE_SUMMARY_GROUPS,
  groupRulesForSummary,
  ruleSummaryParts,
  type RuleSummaryGroup,
} from "@/lib/build-rules-copy";
import { RULE_TONE_STRIPE, ruleTone } from "@/lib/build-rules-quantity";

export interface RulesSummaryProps {
  /** Sanitised saved rules (see coerceSavedRules). Renders nothing when empty. */
  rules: ReadonlyArray<BuildRule>;
  /** Card heading. Both build pages use "Build order". */
  title?: string;
}

interface GroupCopy {
  title: string;
  /** One line under the heading; absent when the heading says it all. */
  hint?: string;
  icon: LucideIcon;
  iconClass: string;
}

const GROUP_COPY: Record<RuleSummaryGroup, GroupCopy> = {
  must: {
    title: "Must have",
    icon: CircleCheck,
    iconClass: "text-success",
  },
  mustNot: {
    title: "Must not have",
    hint: "Starting one before its time means the game doesn't match.",
    icon: Ban,
    iconClass: "text-danger",
  },
  limit: {
    title: "Limits",
    hint: "More than this before the time doesn't match. Games with none pass too.",
    icon: Gauge,
    iconClass: "text-text-muted",
  },
};

/**
 * RulesSummary — a rule-based (v3) build read back in plain words, in
 * the same vocabulary as the editor and the "How rules count" legend:
 * "Must have" (At least / Exactly), "Must not have" (None, Exactly 0,
 * At most 0) and "Limits" (At most 1+), each rule with its icon, its
 * deadline as "before 4:20" and a Proxy badge when it only counts
 * proxied buildings. Shared by the community build page and the private
 * build page. No hooks beyond useId, so it renders on the server too.
 */
export function RulesSummary({ rules, title = "Build order" }: RulesSummaryProps) {
  const headingId = useId();
  if (rules.length === 0) return null;
  const groups = groupRulesForSummary(rules);
  const counted = RULE_SUMMARY_GROUPS.reduce((n, g) => n + groups[g].length, 0);
  return (
    <Card padded={false} className="overflow-hidden">
      <section aria-labelledby={headingId}>
        <header className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-surface/95 px-4 py-3">
          <h2
            id={headingId}
            className="text-caption font-semibold uppercase tracking-wider text-text"
          >
            {title}
          </h2>
          <span className="text-caption text-text-dim">
            {counted} rule{counted === 1 ? "" : "s"}
          </span>
        </header>
        <div className="space-y-5 px-4 py-4">
          <p className="text-caption text-text-muted">
            A game matches this build when every rule below passes.
          </p>
          {RULE_SUMMARY_GROUPS.map((group) =>
            groups[group].length > 0 ? (
              <RuleGroup key={group} group={group} rules={groups[group]} />
            ) : null,
          )}
          <RulesLegend withHelpLink />
        </div>
      </section>
    </Card>
  );
}

function RuleGroup({
  group,
  rules,
}: {
  group: RuleSummaryGroup;
  rules: ReadonlyArray<BuildRule>;
}) {
  const headingId = useId();
  const copy = GROUP_COPY[group];
  const GroupIcon = copy.icon;
  return (
    <section aria-labelledby={headingId} data-rule-group={group}>
      <h3
        id={headingId}
        className="flex items-center gap-1.5 text-caption font-semibold text-text"
      >
        <GroupIcon className={["h-4 w-4", copy.iconClass].join(" ")} aria-hidden />
        {copy.title}
      </h3>
      {copy.hint ? (
        <p className="mt-0.5 text-micro text-text-muted">{copy.hint}</p>
      ) : null}
      <ul role="list" className="mt-2 overflow-hidden rounded-lg border border-border">
        {rules.map((rule, index) => (
          <RuleRow key={`${rule.type}-${rule.name}-${rule.time_lt}-${index}`} rule={rule} />
        ))}
      </ul>
    </section>
  );
}

function RuleRow({ rule }: { rule: BuildRule }) {
  const { quantity, entity, time } = ruleSummaryParts(rule);
  const icon = normalizeBuildName(rule.name);
  const initials = (icon.displayName || rule.name)
    .replace(/^(Build|Train|Research|Morph)\s*/i, "")
    .slice(0, 2);
  return (
    <li
      className={[
        "flex min-h-[44px] items-center gap-3 border-b border-l-2 border-b-border px-3 py-2 last:border-b-0",
        RULE_TONE_STRIPE[ruleTone(rule)],
      ].join(" ")}
    >
      <span className="shrink-0" aria-hidden>
        {icon.iconName ? (
          <Icon name={icon.iconName} kind={icon.iconKind ?? undefined} size={24} decorative />
        ) : (
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-bg-elevated text-micro font-semibold uppercase tracking-wider text-text-dim">
            {initials}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 break-words text-body text-text">
        {quantity ? <strong className="font-semibold">{quantity} </strong> : null}
        {entity}{" "}
        <span className="whitespace-nowrap text-text-muted">
          before{" "}
          <span className="font-mono tabular-nums text-text">{time}</span>
        </span>
      </span>
      {rule.proxy === true ? (
        <Badge
          size="sm"
          variant="warning"
          className="shrink-0"
          title="Only counts buildings placed away from the main base"
        >
          Proxy
        </Badge>
      ) : null}
    </li>
  );
}
