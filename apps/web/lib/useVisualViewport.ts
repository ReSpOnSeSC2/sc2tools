"use client";

import { useLayoutEffect, useState } from "react";

export type VisibleViewport = {
  width: number;
  height: number;
  left: number;
  top: number;
};

/** Layout viewport units alone miss mobile zoom and the on-screen keyboard. */
export function useVisualViewport(active: boolean): VisibleViewport | null {
  const [viewport, setViewport] = useState<VisibleViewport | null>(null);

  useLayoutEffect(() => {
    if (!active || !window.visualViewport) {
      setViewport(null);
      return;
    }
    const visible = window.visualViewport;
    const update = () => setViewport(previous => {
      const next = { width: visible.width, height: visible.height, left: visible.offsetLeft, top: visible.offsetTop };
      return previous && previous.width === next.width && previous.height === next.height
        && previous.left === next.left && previous.top === next.top
        ? previous : next;
    });
    update();
    visible.addEventListener("resize", update);
    visible.addEventListener("scroll", update);
    return () => {
      visible.removeEventListener("resize", update);
      visible.removeEventListener("scroll", update);
    };
  }, [active]);

  return viewport;
}
