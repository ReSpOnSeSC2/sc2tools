"use client";

import { Modal } from "@/components/ui/Modal";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { MapIntelPanel } from "./MapIntelPanel";

export interface MapIntelTarget {
  map: string;
  /** Exact edition names grouped under the row. */
  maps: string[];
}

/**
 * The map detail drawer of an /app/maps row: Map Intel for every game on the
 * map that matches the analyzer filters, with an opponent-race control. A
 * right-hand panel on desktop, a bottom sheet on phones.
 */
export function MapIntelDrawer({ target, filterQuery, dbRev, onClose }: {
  target: MapIntelTarget | null;
  filterQuery: string;
  dbRev: number;
  onClose: () => void;
}) {
  return (
    <Modal open={Boolean(target)} onClose={onClose} size="lg" desktopLayout="side"
      title={target ? `${target.map} map intel` : "Map intel"}
      description={<>Where proxies, fights and lost fights happen in your games. <LazyHelpLink slug="map-intel">How to read it</LazyHelpLink></>}>
      {target ? <MapIntelPanel map={target.map} aliases={target.maps} filterQuery={filterQuery} dbRev={dbRev} matchupControl /> : null}
    </Modal>
  );
}
