import { Banner } from "@/components/Banner";
import { DownloadInteractive } from "@/components/onboarding/DownloadInteractive";

export const metadata = {
  title: "Download the agent · SC2 Tools",
  description:
    "Download the SC2 Tools Agent — a small background watcher that turns every ranked match into a structured record on your dashboard.",
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
    "A small background watcher that turns every finished StarCraft II ranked match into a structured record on your SC2 Tools dashboard.",
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
          on your replays folder. Replays themselves never leave your
          machine — only the parsed JSON record syncs.
        </p>
      </header>

      <Banner variant="divider" />

      <DownloadInteractive />
    </div>
  );
}
