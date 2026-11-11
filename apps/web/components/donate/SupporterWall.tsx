import Link from "next/link";
import { Heart } from "lucide-react";
import { Card } from "@/components/ui";
import { formatDate } from "@/lib/i18n/format";
import { SUPPORTER_WALL_SETTINGS_HREF, type EarlierSupporter, type SupporterEntry, type SupporterWallData } from "@/lib/supporterWall";

function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return formatDate(new Date(Date.UTC(year, index - 1, 1)), { month: "long", year: "numeric", timeZone: "UTC" });
}

function Supporter({ entry }: { entry: SupporterEntry }) {
  // Plain text only: names and messages were filtered on submit and
  // approved by an administrator; React escapes them here.
  return (
    <li className="min-w-0 rounded-lg border border-border bg-bg-elevated/40 px-3 py-2">
      <p className="break-words text-body font-semibold text-text">{entry.displayName}</p>
      {entry.message ? <p className="mt-0.5 break-words text-caption text-text-muted">{entry.message}</p> : null}
    </li>
  );
}

function groupByMonth(rows: readonly EarlierSupporter[]): Array<[string, EarlierSupporter[]]> {
  const groups = new Map<string, EarlierSupporter[]>();
  for (const row of rows) groups.set(row.month, [...(groups.get(row.month) ?? []), row]);
  return [...groups.entries()];
}

/**
 * The opt-in supporter wall: this month's approved supporters, then every
 * earlier month collapsed. Only people who asked to be listed appear, after
 * review, and they can remove themselves at any time.
 */
export function SupporterWall({ wall }: { wall: SupporterWallData | null }) {
  const earlier = wall ? groupByMonth(wall.earlier) : [];
  return (
    <section aria-labelledby="supporter-wall-title" className="mx-auto max-w-5xl space-y-4">
      <header className="space-y-1.5 text-center">
        <h2 id="supporter-wall-title" className="inline-flex items-center gap-2 text-h2 font-semibold">
          <Heart className="h-5 w-5 text-accent-cyan" aria-hidden />
          Supporter wall
        </h2>
        <p className="mx-auto max-w-2xl text-body text-text-muted">
          Supporters who asked to be thanked here. It&rsquo;s opt-in: giving never adds your name, and amounts are never shown.{" "}
          <Link href={SUPPORTER_WALL_SETTINGS_HREF} className="font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Add me to the wall
          </Link>
        </p>
      </header>
      <Card>
        {!wall ? (
          <p role="status" className="text-center text-caption text-text-muted">The supporter wall couldn&rsquo;t load right now. Please check back later.</p>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-caption font-semibold uppercase tracking-wider text-text-muted">This month</h3>
              {wall.thisMonth.length ? (
                <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {wall.thisMonth.map((entry, index) => <Supporter key={`${entry.displayName}-${index}`} entry={entry} />)}
                </ul>
              ) : (
                <p className="mt-2 text-caption text-text-muted">No one is on the wall yet this month.</p>
              )}
            </div>
            {earlier.length ? (
              <details className="group rounded-lg border border-border">
                <summary className="flex min-h-11 cursor-pointer items-center px-3 text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  Earlier supporters ({wall.earlier.length})
                </summary>
                <div className="space-y-3 px-3 pb-3">
                  {earlier.map(([month, rows]) => (
                    <div key={month}>
                      <h4 className="text-caption font-semibold text-text-muted">{monthLabel(month)}</h4>
                      <ul className="mt-1.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {rows.map((entry, index) => <Supporter key={`${month}-${entry.displayName}-${index}`} entry={entry} />)}
                      </ul>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        )}
      </Card>
    </section>
  );
}
