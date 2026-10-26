/** Exact public surfaces that must remain usable without the auth service. */
export function isPublicStatusRoute(pathname: string | null): boolean {
  return pathname === "/status";
}

export function isPublicStatusRequest(pathname: string): boolean {
  return isPublicStatusRoute(pathname) || pathname === "/api/ping";
}

/** Canonicalize the dedicated alias without forwarding account/token queries. */
export function statusHostRedirect(requestUrl: string): string | null {
  try {
    return new URL(requestUrl).hostname === "status.sc2tools.com"
      ? "https://sc2tools.com/status"
      : null;
  } catch {
    return null;
  }
}
