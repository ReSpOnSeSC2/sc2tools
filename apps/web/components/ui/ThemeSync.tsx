"use client";
import { useEffect } from "react";
import { subscribeTheme } from "@/lib/theme";
/** Outside auth/chrome so System also follows the OS on token-only pages. */
export function ThemeSync() {
  useEffect(() => subscribeTheme(() => {}), []);
  return null;
}
