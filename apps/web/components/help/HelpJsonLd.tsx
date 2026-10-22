import { serializeJsonLd } from "@/lib/reviewJsonLd";

/**
 * Structured-data <script> for a help page. serializeJsonLd escapes
 * "<", ">" and "&", so article text can never close the tag.
 */
export function HelpJsonLd({ items }: { items: ReadonlyArray<Record<string, unknown>> }) {
  if (items.length === 0) return null;
  return (
    <script
      type="application/ld+json"
      data-testid="help-jsonld"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(items) }}
    />
  );
}
