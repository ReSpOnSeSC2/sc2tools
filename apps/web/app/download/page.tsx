import { Banner } from "@/components/Banner";
import { DownloadInteractive } from "@/components/onboarding/DownloadInteractive";

export const metadata = {
  title: "Download the agent · SC2 Tools",
  description:
    "Download the SC2 Tools Agent — a small background watcher that turns every ranked match into a structured record on your dashboard.",
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
