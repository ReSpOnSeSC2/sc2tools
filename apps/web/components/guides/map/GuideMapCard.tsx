import Link from "next/link";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { GUIDE_PANEL_CLASS } from "../guideUi";
import { guidePaths } from "../guideMetadata";
import { fmtCount } from "@/lib/guides/format";
import type { GuideIndexMap } from "@/lib/guides/types";

export function GuideMapCard({ map }: { map: GuideIndexMap }) {
  return <Link href={guidePaths.map(map.slug)} className={`${GUIDE_PANEL_CLASS} group/map block min-w-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}><MapArtwork mapName={map.map} size="card" className="aspect-video w-full border-0" /><span className="block p-4"><span className="block break-words font-display text-h4 font-bold text-text">{map.map}</span><span className="block text-caption tabular-nums text-text-dim">{fmtCount(map.games)} games</span></span></Link>;
}
