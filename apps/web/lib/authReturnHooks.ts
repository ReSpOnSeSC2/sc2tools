"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { safeReturnPath } from "./safeReturnPath";

/** Use inside a Suspense boundary so public pages retain static rendering. */
export function useReturnTo(fallback?: string | null): string | null {
  const pathname = usePathname(), params = useSearchParams();
  const query = params?.toString();
  return safeReturnPath(pathname ? pathname + (query ? `?${query}` : "") : null) ?? safeReturnPath(fallback);
}
