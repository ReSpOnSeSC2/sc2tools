import { guidePaths } from "@/components/guides/guideMetadata";

export const MAX_COMPARE_OPENERS = 3;
const SLUG = /^[a-z0-9-]{1,80}$/;

export function compareSelection(raw: unknown): { slugs: string[]; truncated: boolean } {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const unique = [...new Set(values)];
  const slugs = unique.slice(0, MAX_COMPARE_OPENERS);
  if (!slugs.every((slug): slug is string => typeof slug === "string" && SLUG.test(slug))) {
    return { slugs: [], truncated: false };
  }
  return { slugs, truncated: unique.length > MAX_COMPARE_OPENERS };
}

export function openerCompareHref(matchupSlug: string, slugs: readonly string[]): string {
  return guidePaths.compare(matchupSlug) + "?builds=" + slugs.map(encodeURIComponent).join(",");
}
