"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isRoomObsPath } from "@/lib/matchRoomRoute";
import { subscribeTheme } from "@/lib/theme";
/** Outside auth/chrome so System also follows the OS on token-only pages. */
export function ThemeSync() {
  const pathname = usePathname();
  const roomObs = isRoomObsPath(pathname);
  useEffect(() => {
    if (roomObs) {
      document.documentElement.setAttribute("data-theme", "dark");
      document.documentElement.style.colorScheme = "dark";
      return;
    }
    return subscribeTheme(() => {});
  }, [roomObs]);
  return null;
}
