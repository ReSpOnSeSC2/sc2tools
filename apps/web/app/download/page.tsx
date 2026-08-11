import { Banner } from "@/components/Banner";
import { DownloadInteractive } from "@/components/onboarding/DownloadInteractive";

export const metadata = {
  title: "Download the agent · SC2 Tools",
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
  operatingSystem: "Windows, macOS, Linux",
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(SOFTWARE_JSON_LD) }}
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
        <div
          role="note"
          className="max-w-2xl rounded-md border border-accent/35 bg-accent/10 px-4 py-3 text-body text-text"
        >
          <strong>Already using the agent?</strong> Install the latest version,
          choose <strong>All time</strong> for the replay filter, then click{" "}
          <strong>Re-sync replay library</strong> once. That one scan rebuilds
          cloud analysis and archives every original still available on this
          PC; it does not duplicate games.
        </div>
      </header>

      <Banner variant="divider" />

      <DownloadInteractive />
    </div>
  );
}
