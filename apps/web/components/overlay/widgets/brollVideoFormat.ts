"use client";

import { useEffect, useState } from "react";
import type { StudioBrollVideoFormat } from "@/lib/multichat/useStudioState";

/** Resolve an explicit source override, then fall back to OBS canvas geometry. */
export function resolveBrollVideoFormat(
  search: string,
  viewportWidth: number,
  viewportHeight: number,
): StudioBrollVideoFormat {
  const override = new URLSearchParams(search).get("orientation");
  if (override === "vertical" || override === "horizontal") return override;

  const width = Number.isFinite(viewportWidth) ? viewportWidth : 0;
  const height = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return height > width ? "vertical" : "horizontal";
}

/**
 * Wait for the real browser viewport before mounting YouTube. This prevents a
 * portrait OBS source from briefly requesting the landscape simulcast during
 * hydration. The query override supports unusual cropped source layouts.
 */
export function useBrollVideoFormat(): StudioBrollVideoFormat | null {
  const [format, setFormat] = useState<StudioBrollVideoFormat | null>(null);

  useEffect(() => {
    const update = () => {
      setFormat(
        resolveBrollVideoFormat(
          window.location.search,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  return format;
}
