"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { getMapLayoutUrl } from "@/lib/map-images";
import { MapArtwork } from "./MapArtwork";

export type MapPreviewDialogProps = {
  mapName: string | null;
  onClose: () => void;
};

/**
 * Enlarged map artwork shared by the Maps and Trends surfaces.
 *
 * The full, uncropped top-down render is preferred. Older or custom maps may
 * not have that asset, so a failed request falls back to the thumbnail
 * registry and ultimately MapArtwork's deterministic initials treatment.
 */
export function MapPreviewDialog({
  mapName,
  onClose,
}: MapPreviewDialogProps) {
  const name = mapName?.trim() || null;
  const layoutUrl = getMapLayoutUrl(name);
  const [failedLayoutUrl, setFailedLayoutUrl] = useState<string | null>(null);
  const showLayout = Boolean(layoutUrl && failedLayoutUrl !== layoutUrl);
  const alt = name ? `Enlarged preview of ${name}` : "Map preview";

  // A fresh map selection gets a fresh layout attempt. Resetting while closed
  // also lets a transiently unavailable asset recover when the same map is
  // reopened later.
  useEffect(() => {
    setFailedLayoutUrl(null);
  }, [name, layoutUrl]);

  return (
    <Modal
      open={Boolean(name)}
      onClose={onClose}
      title={name ? `${name} map preview` : "Map preview"}
      description="Full-size map overview"
      size="xl"
      mobileLayout="center"
    >
      <div className="flex h-[min(68dvh,52rem)] min-h-64 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-black/80">
        {showLayout ? (
          <img
            key={layoutUrl}
            src={layoutUrl!}
            alt={alt}
            loading="eager"
            decoding="async"
            className="h-full w-full object-contain"
            onError={() => setFailedLayoutUrl(layoutUrl)}
          />
        ) : (
          <MapArtwork
            mapName={name}
            size="hero"
            eager
            alt={alt}
            fit="contain"
            className="border-0 bg-black/80"
          />
        )}
      </div>
    </Modal>
  );
}
