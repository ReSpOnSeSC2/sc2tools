import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { useAuth } from "@clerk/nextjs";
import { FiltersContext, useFilters, type AnalyzerFilters } from "@/lib/filterContext";
import { AnalyzerProvider, filtersFromViewQuery } from "@/components/AnalyzerProvider";
import { RealtimeProvider } from "@/components/realtime/RealtimeProvider";
import { viewFiltersFromQuery } from "@/lib/analyzerViews";
import { AnalyzerFilterUrlSync } from "@/components/analyzer/AnalyzerFilterUrlSync";
import { SessionsPage } from "@/components/sessions/SessionsPage";
import { SessionDetail } from "@/components/sessions/SessionDetail";
import { CurrentSessionCard } from "@/components/sessions/CurrentSessionCard";
import { AllGamesTable } from "@/components/analyzer/AllGamesTable";
import { Card } from "@/components/ui/Card";



const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = () => { for (const listener of listeners) listener(); };
for (const event of ["popstate", "hashchange"]) addEventListener(event, emit);
const navigate = (href: string, replace = false) => { history[replace ? "replaceState" : "pushState"]({}, "", href); emit(); };
Object.assign(window, { sessionHistoryNavigation: { subscribe, navigate, readPath: () => location.pathname, readSearch: () => location.search } });
const initial: AnalyzerFilters = { preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false };
function App() {
  const auth = useAuth();
  const route = useSyncExternalStore(subscribe, () => location.pathname + location.search);
  const [filters, setFilters] = useState(() => filtersFromViewQuery(initial, viewFiltersFromQuery(new URLSearchParams(location.search))));
  const detail = location.pathname.startsWith("/app/sessions/");
  const raceContrast = new URLSearchParams(location.search).get("raceContrast") === "1";
  return <FiltersContext.Provider value={{ filters, setFilters, dbRev: 0, bumpRev: () => undefined, seasons: [] }}>
    <main className="mx-auto max-w-6xl space-y-5 p-4 text-text sm:p-6">
      <h1 className="font-display text-h2">Session history component verification</h1>
      <p className="text-caption text-text-muted">Synthetic loopback records. Actual history components, API helper, URL writer and filter synchronization.</p>
      <nav aria-label="Fixture boundaries" className="flex flex-wrap gap-3">
        <button type="button" className="min-h-11 rounded border border-border px-3" onClick={() => (window as FixtureWindow).sessionsAuth.set("synthetic-a")}>Owner A</button>
        <button type="button" className="min-h-11 rounded border border-border px-3" onClick={() => (window as FixtureWindow).sessionsAuth.set("synthetic-b")}>Owner B</button>
        <button type="button" className="min-h-11 rounded border border-border px-3" onClick={() => setFilters({ ...filters, race: filters.race === "Z" ? "P" : "Z" })}>Change membership race</button>
        <output aria-label="Fixture owner">{auth.userId}</output>
      </nav>
      {!raceContrast && route.startsWith("/app/sessions") ? <AnalyzerFilterUrlSync ready filters={filters} onNavigate={parsed => setFilters(value => filtersFromViewQuery(value, parsed))} /> : null}
      {raceContrast ? <RaceContrastSurface /> : route.startsWith("/app/sessions") ? detail ? <SessionDetail id={decodeURIComponent(location.pathname.split("/").at(-1) ?? "")} /> : <SessionsPage />
        : <LiveCurrentSurface />}
    </main>
  </FiltersContext.Provider>;
}
function RaceContrastSurface() {
  const rows = [
    { opp_race: "P", opp_strategy: "Recorded Protoss" },
    { opp_race: "T", opp_strategy: "Recorded Terran" },
    { opp_race: "Z", opp_strategy: "Recorded Zerg" },
    { opp_race: "R", opp_strategy: "Recorded Random" },
    { opp_race: null, opp_strategy: null },
    { opp_race: null, opp_strategy: "Terran - Proxy Rax" },
  ].map((race, index) => ({ ...race, id: null, date: `2026-10-27T04:0${index}:00.000Z`, map: null, my_race: "P" }));
  return <Card title="Recorded race labels" headingLevel={2}>
    <AllGamesTable games={rows} rowKey={(_row, index) => `race-palette:${index}`} />
  </Card>;
}
function LiveCurrentSurface() {
  return <RealtimeProvider><AnalyzerProvider syncUrl><CurrentScopeObservation /><CurrentSessionCard /></AnalyzerProvider></RealtimeProvider>;
}

function CurrentScopeObservation() {
  const { filters } = useFilters();
  useEffect(() => { Object.assign(window, { historyCurrentFilters: { ...filters } }); return () => { Reflect.deleteProperty(window, "historyCurrentFilters"); }; }, [filters]);
  return null;
}

type FixtureWindow = typeof window & { sessionsAuth: { set: (owner: "synthetic-a" | "synthetic-b") => void } };
const root = createRoot(document.getElementById("root")!);
Object.assign(window, { sessionHistoryUnmount: () => root.unmount() });
root.render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }}><App /></SWRConfig>);
