export const REPORT_CARD_TYPE = "report";
const CARD_CLASSES = ["summary", "compare"] as const;
const CARD_PREFIX = "/card/";
const PREVIEW_SUFFIX = "/opengraph-image";

export type ReportCardClass = (typeof CARD_CLASSES)[number];

export function reportCardParams() {
  return CARD_CLASSES.map(cardClass => ({ type: REPORT_CARD_TYPE, class: cardClass }));
}

export function reportCardClass(type: string, value: string): ReportCardClass | null {
  return type === REPORT_CARD_TYPE ? CARD_CLASSES.find(cardClass => cardClass === value) ?? null : null;
}

export function reportCardPath(cardClass: ReportCardClass): string {
  return `${CARD_PREFIX}${REPORT_CARD_TYPE}/${cardClass}`;
}

export function reportCardPreviewPath(cardClass: ReportCardClass): string {
  return `${reportCardPath(cardClass)}${PREVIEW_SUFFIX}`;
}

export const REPORT_CARD_PATH = reportCardPath("summary");
export const REPORT_COMPARE_PATH = reportCardPath("compare");

export function canonicalReportCardPath(pathname: string | null | undefined): string | null {
  // Next decodes the dynamic segments once. Escapes must preserve their boundaries.
  if (!pathname?.startsWith(CARD_PREFIX) || /%2f/i.test(pathname)) return null;
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded === REPORT_CARD_PATH || decoded === REPORT_COMPARE_PATH ? decoded : null;
  } catch {
    return null;
  }
}

export function isReportCardPath(pathname: string | null | undefined): boolean {
  return canonicalReportCardPath(pathname) !== null;
}

export function isReportCardPreviewPath(pathname: string): boolean {
  return pathname.endsWith(PREVIEW_SUFFIX) && isReportCardPath(pathname.slice(0, -PREVIEW_SUFFIX.length));
}
