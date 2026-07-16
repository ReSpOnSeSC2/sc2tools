"use client";

/* eslint-disable @next/next/no-img-element */

import { useState, type CSSProperties } from "react";
import { getMapImageUrl, resolveMapImage } from "@/lib/map-images";

type ArtworkSize = "xs" | "sm" | "md" | "card" | "hero";

const SIZE_CLASSES: Record<ArtworkSize, string> = {
  xs: "h-6 w-8 rounded-sm",
  sm: "h-9 w-12 rounded-md",
  md: "h-12 w-16 rounded-md",
  card: "h-full w-full rounded-none",
  hero: "h-full w-full rounded-none",
};

const IMAGE_SIZES: Record<ArtworkSize, string> = {
  xs: "32px",
  sm: "48px",
  md: "64px",
  card: "(max-width: 768px) 100vw, 33vw",
  hero: "100vw",
};

export function MapArtwork({
  mapName,
  size = "sm",
  className = "",
  eager = false,
  alt = "",
}: {
  mapName: string | null | undefined;
  size?: ArtworkSize;
  className?: string;
  eager?: boolean;
  alt?: string;
}) {
  const source = getMapImageUrl(mapName);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showImage = Boolean(source && failedSource !== source);
  const fallbackStyle = fallbackGradient(mapName || "Map");

  return (
    <span
      data-map-artwork={showImage ? "image" : "fallback"}
      className={`relative block shrink-0 overflow-hidden border border-border bg-bg-elevated ${SIZE_CLASSES[size]} ${className}`}
      style={fallbackStyle}
    >
      <span
        aria-hidden
        className="absolute inset-0 grid place-items-center text-[9px] font-bold uppercase tracking-[0.08em] text-white/55"
      >
        {initials(mapName)}
      </span>
      {showImage ? (
        <img
          src={source!}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          sizes={IMAGE_SIZES[size]}
          onError={() => setFailedSource(source)}
          className="absolute inset-0 h-full w-full object-cover motion-safe:transition-[filter,transform] motion-safe:duration-300 motion-safe:ease-out group-hover/map:scale-[1.06] group-hover/map:brightness-110"
        />
      ) : null}
    </span>
  );
}

export function MapLabel({
  name,
  size = "sm",
  className = "",
  textClassName = "",
  preview = false,
  showNativeTitle = true,
}: {
  name: string | null | undefined;
  size?: "xs" | "sm" | "md";
  className?: string;
  textClassName?: string;
  preview?: boolean;
  showNativeTitle?: boolean;
}) {
  const label = name?.trim() || "Unknown map";
  const hasArtwork = Boolean(resolveMapImage(name));

  return (
    <span
      className={`group/map relative inline-flex min-w-0 items-center gap-2 ${className}`}
      title={preview || !showNativeTitle ? undefined : label}
    >
      <MapArtwork mapName={name} size={size} />
      <span className={`min-w-0 truncate ${textClassName}`}>{label}</span>
      {preview && hasArtwork ? (
        <span
          aria-hidden
          data-map-preview
          className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-50 hidden w-56 translate-y-1 overflow-hidden rounded-lg border border-border-strong bg-bg-elevated opacity-0 shadow-xl motion-safe:transition-all motion-safe:duration-200 sm:block sm:group-hover/map:translate-y-0 sm:group-hover/map:opacity-100 sm:group-focus-within/map:translate-y-0 sm:group-focus-within/map:opacity-100"
        >
          <span className="relative block aspect-video overflow-hidden">
            <MapArtwork mapName={name} size="card" className="border-0" />
            <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent" />
            <span className="absolute inset-x-0 bottom-0 block truncate px-3 py-2 text-left text-caption font-semibold text-white drop-shadow-md">
              {label}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

function initials(value: string | null | undefined): string {
  const words = String(value || "Map")
    .replace(/\s+(?:LE|TE|CE|RE)$/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function fallbackGradient(value: string): CSSProperties {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  const hue = 190 + (hash % 70);
  return {
    backgroundImage: `radial-gradient(circle at 28% 20%, hsla(${hue}, 78%, 56%, .36), transparent 45%), linear-gradient(145deg, hsl(${hue}, 34%, 22%), hsl(${(hue + 42) % 360}, 30%, 9%))`,
  };
}
