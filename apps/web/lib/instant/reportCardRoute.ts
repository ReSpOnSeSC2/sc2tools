export const REPORT_CARD_SEGMENTS = { type: "report", class: "summary" } as const;
export const REPORT_CARD_PATH = `/card/${REPORT_CARD_SEGMENTS.type}/${REPORT_CARD_SEGMENTS.class}`;

export function isReportCardPath(pathname: string | null | undefined): boolean {
  if (pathname === REPORT_CARD_PATH) return true;
  if (!pathname?.startsWith("/card/") || !pathname.includes("%")) return false;
  const segments = pathname.slice("/card/".length).split("/");
  if (segments.length !== 2) return false;
  try {
    // Next decodes each dynamic segment once. Keep the privacy guards on
    // those aliases without letting escapes change the segment boundaries.
    return decodeURIComponent(segments[0]) === REPORT_CARD_SEGMENTS.type
      && decodeURIComponent(segments[1]) === REPORT_CARD_SEGMENTS.class;
  } catch {
    return false;
  }
}
