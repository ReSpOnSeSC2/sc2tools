import Link from "next/link";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { GuideSection } from "../GuideSection";
import { guidePaths } from "../guideMetadata";
import { GUIDE_LINK_CLASS } from "../guideUi";
import type { GuideIndexMap } from "@/lib/guides/types";

export function OtherMaps({ current, maps }: { current: string; maps: readonly GuideIndexMap[] | null }) {
  const others = maps?.filter((map) => map.slug !== current).slice(0, 8) ?? [];
  if (!others.length || !maps) return null;
  const position = maps.findIndex((map) => map.slug === current);
  const previous = position > 0 ? maps[position - 1] : null;
  const next = position >= 0 ? maps[position + 1] : null;
  return <GuideSection id="other-maps" title="Other maps"><ul className="flex flex-wrap gap-3">{others.map((map) => <li key={map.slug}><Link href={guidePaths.map(map.slug)} className={`${GUIDE_LINK_CLASS} group/map inline-flex min-h-11 items-center gap-2 rounded-lg border border-border pr-3`}><MapArtwork mapName={map.map} size="sm" />{map.map}</Link></li>)}</ul><nav aria-label="Previous and next map" className="mt-4 flex flex-wrap justify-between gap-4">{previous ? <Link href={guidePaths.map(previous.slug)} className={GUIDE_LINK_CLASS} aria-label={`Previous map: ${previous.map}`}>← {previous.map}</Link> : <span />}{next ? <Link href={guidePaths.map(next.slug)} className={GUIDE_LINK_CLASS} aria-label={`Next map: ${next.map}`}>{next.map} →</Link> : null}</nav></GuideSection>;
}
