"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { GuideMapCard } from "./GuideMapCard";
import { MapPoolTable } from "./MapPoolTable";
import type { GuideIndexMap } from "@/lib/guides/types";

export function MapViews({ maps }: { maps: ReadonlyArray<GuideIndexMap> }) {
  const [view, setView] = useState("gallery");
  const hasCells = maps.some((map) => map.cells?.length);
  useEffect(() => { try { if (hasCells && localStorage.getItem("guides.maps.view") === "table") setView("table"); } catch { /* Storage is optional; the server gallery remains usable. */ } }, [hasCells]);
  function choose(value: string) { setView(value); try { localStorage.setItem("guides.maps.view", value); } catch { /* Keep this tab's explicit choice. */ } }
  return <div className="space-y-4">
    {hasCells ? <div role="group" aria-label="Map view" className="flex gap-2"><Button variant="secondary" aria-pressed={view === "gallery"} onClick={() => choose("gallery")}>Gallery</Button><Button variant="secondary" aria-pressed={view === "table"} onClick={() => choose("table")}>Table</Button></div> : null}
    {hasCells && view === "table" ? <MapPoolTable maps={maps} /> : <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{maps.map((map) => <li key={map.slug} className="min-w-0"><GuideMapCard map={map} /></li>)}</ul>}
  </div>;
}
