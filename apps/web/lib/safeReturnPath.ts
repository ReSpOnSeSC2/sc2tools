/** Post-auth destinations are an explicit set of public/action pages. */
const ROOTS = ["community", "guides", "reviews", "p", "players", "try", "stream-studio", "download", "donate", "help"];
export const RETURN_PATH_LIMIT = 512;

/** Accept one outer encoding for old /try links; reject hidden separators,
 * dot segments, fragments, malformed escapes and non-relative destinations.
 * The result is always a canonical same-origin path, never an external URL. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > RETURN_PATH_LIMIT) return null;
  let candidate = value;
  try {
    if (!candidate.startsWith("/") && /^%2f/i.test(candidate)) candidate = decodeURIComponent(candidate);
    const decoded = decodeURIComponent(candidate);
    if (/[\s\\#\u0000-\u001f\u007f]/.test(candidate) || /[\s\\#\u0000-\u001f\u007f]/.test(decoded)) return null;
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
    const path = candidate.split("?", 1)[0];
    if (path.includes("//") || /%(?:2f|5c|3f|23|25)/i.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodeURIComponent(path))) return null;
    const url = new URL(candidate, "https://return.invalid");
    if (url.origin !== "https://return.invalid" || url.hash || url.username || url.password) return null;
    if (url.pathname === "/settings") {
      if (!["overlay", "profile"].includes(url.searchParams.get("tab") || "") || [...url.searchParams.keys()].length !== 1) return null;
    } else if (!ROOTS.some(root => url.pathname === `/${root}` || url.pathname.startsWith(`/${root}/`))) return null;
    // Preserve the existing claim hand-off's narrow contract.
    if (url.pathname === "/try" && url.search && (url.searchParams.get("resume") !== "1" || [...url.searchParams.keys()].length !== 1)) return null;
    const result = url.pathname + url.search;
    return result.length <= RETURN_PATH_LIMIT ? result : null;
  } catch { return null; }
}

/** A stable, non-personal label for the wizard's continuation banner. */
export function returnPathLabel(path: string): string {
  const root = path.split(/[/?]/)[1];
  return ({ community: "Community build", guides: "Build guide", reviews: "Replay review", p: "Player page", players: "Player page", try: "Replay report", "stream-studio": "Stream Studio", download: "Download", donate: "Donate page", help: "Help article", settings: "Settings" } as Record<string, string>)[root] || "Your page";
}
