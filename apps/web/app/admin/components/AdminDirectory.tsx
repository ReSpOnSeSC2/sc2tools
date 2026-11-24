import Link from "next/link";

import { Card } from "@/components/ui/Card";
import { NAV_GROUPS } from "./AdminShell";

const GROUP_BLURB: Record<string, string> = {
  Overview: "Where to start each day.",
  Community: "People, submissions and reports.",
  Insights: "Platform-wide numbers and traffic.",
  Operations: "Audit, repair and system health.",
  Content: "Builds, guides and notices players see.",
};

/** Every admin destination, grouped like the side navigation, one line each. */
export function AdminDirectory() {
  return (
    <section aria-labelledby="admin-directory-title" className="space-y-4">
      <div>
        <p className="hud-label">Directory</p>
        <h2 id="admin-directory-title" className="text-h3 font-bold tracking-tight text-text">All admin areas</h2>
        <p className="text-body text-text-muted">Every destination in one place, grouped by what you are trying to do.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {NAV_GROUPS.map((group) => (
          <Card key={group.label} variant="default" className="space-y-3">
            <div>
              <h3 className="text-body font-semibold text-text">{group.label}</h3>
              <p className="text-caption text-text-muted">{GROUP_BLURB[group.label] ?? ""}</p>
            </div>
            <ul className="space-y-1">
              {group.items.map((entry) => {
                const Icon = entry.icon;
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      className="flex min-h-11 items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-caption font-semibold text-text">{entry.label}</span>
                        <span className="block text-caption text-text-muted">{entry.description}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}
