"use client";

/* eslint-disable @next/next/no-img-element */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
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

const PREVIEW_WIDTH = 224;
const PREVIEW_HEIGHT = 128;
const PREVIEW_GAP = 8;
const PREVIEW_VIEWPORT_MARGIN = 8;

type PreviewPosition = {
  height: number;
  left: number;
  top: number;
  width: number;
  placement: "top" | "bottom";
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
}: {
  name: string | null | undefined;
  size?: "xs" | "sm" | "md";
  className?: string;
  textClassName?: string;
  preview?: boolean;
}) {
  const label = name?.trim() || "Unknown map";
  const hasArtwork = Boolean(resolveMapImage(name));
  const canPreview = preview && hasArtwork;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const previewRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [previewHovered, setPreviewHovered] = useState(false);
  const [previewPosition, setPreviewPosition] =
    useState<PreviewPosition | null>(null);
  const previewOpen = canPreview && (hovered || previewHovered);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const dismissPreview = useCallback(() => {
    clearCloseTimer();
    setHovered(false);
    setPreviewHovered(false);
  }, [clearCloseTimer]);

  const updatePreviewPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;

    const visualViewport = window.visualViewport;
    const viewport = {
      left: visualViewport?.offsetLeft ?? 0,
      top: visualViewport?.offsetTop ?? 0,
      width: visualViewport?.width ?? window.innerWidth,
      height: visualViewport?.height ?? window.innerHeight,
    };
    const triggerRect = trigger.getBoundingClientRect();
    const availableWidth = Math.max(
      0,
      viewport.width - PREVIEW_VIEWPORT_MARGIN * 2,
    );
    const viewportBottom = viewport.top + viewport.height;
    const availableAbove =
      triggerRect.top -
      viewport.top -
      PREVIEW_VIEWPORT_MARGIN -
      PREVIEW_GAP;
    const availableBelow =
      viewportBottom -
      PREVIEW_VIEWPORT_MARGIN -
      triggerRect.bottom -
      PREVIEW_GAP;
    const availableSideHeight = Math.max(
      0,
      availableAbove,
      availableBelow,
    );
    const scale = Math.max(
      0,
      Math.min(
        1,
        availableWidth / PREVIEW_WIDTH,
        availableSideHeight / PREVIEW_HEIGHT,
      ),
    );
    const previewWidth = PREVIEW_WIDTH * scale;
    const previewHeight = PREVIEW_HEIGHT * scale;

    if (previewWidth === 0 || previewHeight === 0) {
      setPreviewPosition(null);
      return;
    }

    setPreviewPosition(
      positionPreview(
        triggerRect,
        previewWidth,
        previewHeight,
        viewport,
      ),
    );
  }, []);

  useEffect(() => {
    if (!previewOpen || typeof window === "undefined") return;

    updatePreviewPosition();
    const visualViewport = window.visualViewport;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissPreview();
    };
    window.addEventListener("resize", updatePreviewPosition);
    window.addEventListener("scroll", updatePreviewPosition, true);
    visualViewport?.addEventListener("resize", updatePreviewPosition);
    visualViewport?.addEventListener("scroll", updatePreviewPosition);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      clearCloseTimer();
      window.removeEventListener("resize", updatePreviewPosition);
      window.removeEventListener("scroll", updatePreviewPosition, true);
      visualViewport?.removeEventListener("resize", updatePreviewPosition);
      visualViewport?.removeEventListener("scroll", updatePreviewPosition);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    clearCloseTimer,
    dismissPreview,
    previewOpen,
    updatePreviewPosition,
  ]);

  const openFromPointer = () => {
    if (!canPreview) return;
    clearCloseTimer();
    updatePreviewPosition();
    setHovered(true);
  };

  const closeFromPointer = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setHovered(false);
    }, 120);
  };

  const openFromPreview = () => {
    clearCloseTimer();
    setPreviewHovered(true);
  };

  const closeFromPreview = () => {
    clearCloseTimer();
    setPreviewHovered(false);
    setHovered(false);
  };

  return (
    <>
      <span
        ref={triggerRef}
        className={`group/map relative inline-flex min-w-0 items-center gap-2 ${className}`}
        title={canPreview ? undefined : label}
        onMouseEnter={canPreview ? openFromPointer : undefined}
        onMouseLeave={canPreview ? closeFromPointer : undefined}
      >
        <MapArtwork mapName={name} size={size} />
        <span className={`min-w-0 truncate ${textClassName}`}>{label}</span>
      </span>
      {previewOpen && previewPosition && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={previewRef}
              aria-hidden
              data-map-preview
              data-placement={previewPosition.placement}
              className="pointer-events-auto fixed z-[55] hidden max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl motion-safe:animate-[fadeIn_140ms_ease-out] sm:block"
              style={{
                height: previewPosition.height,
                left: previewPosition.left,
                top: previewPosition.top,
                width: previewPosition.width,
              }}
              onMouseEnter={openFromPreview}
              onMouseLeave={closeFromPreview}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <span className="relative block h-full overflow-hidden">
                <MapArtwork mapName={name} size="card" className="border-0" />
                <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent" />
                <span className="absolute inset-x-0 bottom-0 block truncate px-3 py-2 text-left text-caption font-semibold text-white drop-shadow-md">
                  {label}
                </span>
              </span>
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function positionPreview(
  trigger: DOMRect,
  previewWidth: number,
  previewHeight: number,
  viewport: { left: number; top: number; width: number; height: number },
): PreviewPosition {
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const minLeft = viewport.left + PREVIEW_VIEWPORT_MARGIN;
  const maxLeft = Math.max(
    minLeft,
    viewportRight - previewWidth - PREVIEW_VIEWPORT_MARGIN,
  );
  const minTop = viewport.top + PREVIEW_VIEWPORT_MARGIN;
  const maxTop = Math.max(
    minTop,
    viewportBottom - previewHeight - PREVIEW_VIEWPORT_MARGIN,
  );
  const spaceAbove = trigger.top - minTop;
  const spaceBelow = viewportBottom - PREVIEW_VIEWPORT_MARGIN - trigger.bottom;
  const placement =
    spaceAbove >= previewHeight + PREVIEW_GAP || spaceAbove >= spaceBelow
      ? "top"
      : "bottom";
  const preferredLeft = trigger.left + (trigger.width - previewWidth) / 2;
  const preferredTop =
    placement === "top"
      ? trigger.top - previewHeight - PREVIEW_GAP
      : trigger.bottom + PREVIEW_GAP;

  return {
    height: previewHeight,
    left: clamp(preferredLeft, minLeft, maxLeft),
    top: clamp(preferredTop, minTop, maxTop),
    width: previewWidth,
    placement,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
