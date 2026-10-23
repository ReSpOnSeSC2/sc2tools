"use client";

import { useEffect, useState } from "react";

/** Keep the first client render identical to the server before detecting Mac. */
export function useReviewShortcutLabel() {
  const [label, setLabel] = useState("Ctrl+Enter");
  useEffect(() => {
    if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform)) setLabel("⌘+Enter");
  }, []);
  return label;
}
