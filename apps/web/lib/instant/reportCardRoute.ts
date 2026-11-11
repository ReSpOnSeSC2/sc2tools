export const REPORT_CARD_SEGMENTS = { type: "report", class: "summary" } as const;
export const REPORT_CARD_PATH = `/card/${REPORT_CARD_SEGMENTS.type}/${REPORT_CARD_SEGMENTS.class}`;

export function isReportCardPath(pathname: string | null | undefined): boolean {
  return pathname === REPORT_CARD_PATH;
}
