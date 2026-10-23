import { serializeJsonLd } from "@/lib/reviewJsonLd";
import { Banner } from "@/components/Banner";
import { ResyncNotice, InstalledAgentVersion } from "@/components/onboarding/DownloadAccountStatus";
import { DownloadInteractive } from "@/components/onboarding/DownloadInteractive";

export const metadata = {
  title: "Download the agent",
  description:
    "Download the SC2 Tools Agent to sync replay analysis and original StarCraft II replay files to your private dashboard library.",
  alternates: { canonical: "/download" },
};

/**
 * SoftwareApplication structured data — lets search engines treat the
 * agent as an installable app (eligible for rich results showing
 * platform, category, and price).
 */
const SOFTWARE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "SC2 Tools Agent",
  applicationCategory: "GameApplication",
  // The published installer is Windows-only (macOS and Linux run the agent
  // from source), so search results shouldn't promise a Mac download.
  operatingSystem: "Windows 10, Windows 11",
  description:
    "A background watcher that syncs StarCraft II replay analysis and original replay files to a private SC2 Tools dashboard library.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

/**
 * /download — public landing for the agent installer.
 *
 * Kept as a server component so it can keep using the filesystem-
 * backed `<Banner />`. The OS picker, download card, and sidebars
 * live in `<DownloadInteractive />` (a client island).
 */
export default function DownloadPage() {
  return (
    <div className="space-y-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(SOFTWARE_JSON_LD) }}
      />
      <header className="space-y-3">
        <h1 className="text-display-lg font-semibold tracking-tight text-text">
          Download the SC2 Tools Agent
        </h1>
        <p className="max-w-2xl text-body-lg text-text-muted">
          A small background watcher that turns every finished ranked
          match into a structured record on your dashboard. Read-only
          on your replays folder. Parsed analysis and the original replay
          sync securely to your private cloud library, where only your
          account can review or download them.
        </p>
        <InstalledAgentVersion />
        <ResyncNotice />
      </header>

      <Banner variant="divider" />

      <DownloadInteractive />
    </div>
  );
}
