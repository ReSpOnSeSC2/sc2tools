"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { MapArtwork } from "@/components/maps/MapArtwork";

const MapPreviewDialog = dynamic(() => import("@/components/maps/MapPreviewDialog").then((module) => module.MapPreviewDialog));
export function MapHeroEnlarge({ mapName }: { mapName: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" aria-label={`Enlarge map: ${mapName}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="group/map relative aspect-video w-full overflow-hidden rounded-xl border-2 border-line shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><MapArtwork mapName={mapName} size="card" eager alt={`${mapName} map`} className="h-full w-full border-0" /></button>{open ? <MapPreviewDialog mapName={mapName} onClose={() => setOpen(false)} /> : null}</>;
}
