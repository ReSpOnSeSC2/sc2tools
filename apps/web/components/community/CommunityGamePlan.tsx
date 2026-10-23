import { useId } from "react";
import { ArrowRightLeft, ShieldAlert, Trophy, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { STRATEGY_NOTE_MAX_CHARS, STRATEGY_NOTE_MAX_ITEMS } from "@/lib/build-rules";

export interface CommunityGamePlanProps {
  /** The snapshot's `winConditions`, `losesTo` and `transitionsInto` (untrusted). */
  winConditions: unknown;
  losesTo: unknown;
  transitionsInto: unknown;
}

interface PlanList {
  key: string;
  title: string;
  icon: LucideIcon;
  iconClass: string;
  items: string[];
}

/** Non-empty strings only, trimmed and capped like the editor caps them. */
export function planItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (out.length >= STRATEGY_NOTE_MAX_ITEMS) break;
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (text) out.push(text.slice(0, STRATEGY_NOTE_MAX_CHARS));
  }
  return out;
}

/**
 * "Game plan" on a community build: the author's Win conditions, Loses to
 * and Transitions into lists (the editor's strategy notes, already part of
 * the public snapshot). An empty list is left out, and the whole card is
 * hidden when the author wrote none.
 */
export function CommunityGamePlan({
  winConditions,
  losesTo,
  transitionsInto,
}: CommunityGamePlanProps) {
  const headingId = useId();
  const lists: PlanList[] = [
    {
      key: "win",
      title: "Win conditions",
      icon: Trophy,
      iconClass: "text-success",
      items: planItems(winConditions),
    },
    {
      key: "loses",
      title: "Loses to",
      icon: ShieldAlert,
      iconClass: "text-danger",
      items: planItems(losesTo),
    },
    {
      key: "transitions",
      title: "Transitions into",
      icon: ArrowRightLeft,
      iconClass: "text-accent-cyan",
      items: planItems(transitionsInto),
    },
  ].filter((list) => list.items.length > 0);
  if (lists.length === 0) return null;

  return (
    <Card padded={false} className="overflow-hidden">
      <section aria-labelledby={headingId}>
        <header className="border-b border-border bg-bg-surface/95 px-4 py-3">
          <h2
            id={headingId}
            className="text-caption font-semibold uppercase tracking-wider text-text"
          >
            Game plan
          </h2>
        </header>
        <div className="divide-y divide-border">
          {lists.map((list) => (
            <PlanSection key={list.key} list={list} />
          ))}
        </div>
      </section>
    </Card>
  );
}

function PlanSection({ list }: { list: PlanList }) {
  const headingId = useId();
  const ListIcon = list.icon;
  return (
    <section aria-labelledby={headingId} className="px-4 py-3">
      <h3
        id={headingId}
        className="flex items-center gap-1.5 text-caption font-semibold text-text"
      >
        <ListIcon className={["h-4 w-4", list.iconClass].join(" ")} aria-hidden />
        {list.title}
      </h3>
      <ul role="list" className="mt-2 list-disc space-y-1 pl-5 text-body text-text marker:text-text-dim">
        {list.items.map((item, index) => (
          <li key={`${index}-${item}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
