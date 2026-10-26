import type { DockScouting } from "@/lib/liveScouting";
import { ForecastStats } from "./ForecastStats";

export function ScoutingFacts({ data, compactOnPhone = false }: { data: DockScouting; compactOnPhone?: boolean }) {
  return <div className="space-y-3">
    <p className="text-body font-semibold">{data.h2h ? data.h2h.wins + data.h2h.losses === 0 ? "First meeting — no history yet" : `Your record: ${data.h2h.wins}W ${data.h2h.losses}L` : "No confirmed record yet"}</p>
    {data.alsoPlaysAs?.length ? <p className="break-words text-caption text-text-muted [overflow-wrap:anywhere]"><span className="rounded-full border border-border px-2 py-1">also: {data.alsoPlaysAs.slice(0, 3).join(", ")}{data.alsoPlaysAs.length > 3 ? ` +${data.alsoPlaysAs.length - 3} more` : ""}</span></p> : null}
    {data.forecast !== undefined ? <ForecastStats value={data.forecast} compactOnPhone={compactOnPhone} /> : data.openings.length ? <div><h3 className="text-caption font-semibold text-text-muted">They usually open</h3><ul className="mt-1 space-y-1">{data.openings.map(row => <li key={row.name} className="break-words text-body">{row.name} <span className="text-caption text-text-muted">· {row.samples} of {row.of} games</span></li>)}</ul></div> : null}
    {data.answer ? <p className={`break-words text-body ${compactOnPhone ? "hidden sm:block" : ""}`}><span className="font-semibold">Your best answer:</span> {data.answer}</p> : null}
    {data.cheese !== null ? <p className={`rounded-lg border border-warning/40 bg-warning/10 p-2 text-caption text-text ${compactOnPhone ? "hidden sm:block" : ""}`}>Cheese warning · {Math.round(data.cheese * 100)}% weighted share in your recorded sample</p> : null}
  </div>;
}
