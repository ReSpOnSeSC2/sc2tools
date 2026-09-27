import type { Metadata } from "next";
import { LandingPageContent } from "@/components/landing/LandingPageContent";

/**
 * Landing route. The page body lives in LandingPageContent; this module
 * only owns route metadata and the site-wide structured data.
 */

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

export const metadata: Metadata = {
  // Self-referencing canonical so query params (?source=pwa, utm_*) don't
  // fragment ranking signals across "duplicate" URLs.
  alternates: { canonical: "/" },
};

/**
 * Organization + WebSite structured data. Helps Google build the brand
 * knowledge panel and surface a sitelinks search box for "sc2tools".
 */
const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "SC2 Tools",
  url: SITE_URL,
  logo: `${SITE_URL}/logo.png`,
};

const WEBSITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "SC2 Tools",
  url: SITE_URL,
  description:
    "Replay analysis, opponent intel, build coaching, and a complete OBS Stream Studio for StarCraft II.",
};

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_JSON_LD) }}
      />
      <LandingPageContent />
    </div>
  );
}
