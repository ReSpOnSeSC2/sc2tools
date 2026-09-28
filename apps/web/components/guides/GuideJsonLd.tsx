import { serializeJsonLd } from "@/lib/reviewJsonLd";

/**
 * Structured-data <script> for a guide page. Uses the review page's
 * escaping serializer so text from the payload (video titles, notes)
 * can never close the script tag.
 */
export function GuideJsonLd({ items }: { items: ReadonlyArray<Record<string, unknown>> }) {
  if (items.length === 0) return null;
  return (
    <script
      type="application/ld+json"
      data-testid="guide-jsonld"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(items) }}
    />
  );
}
