export const metadata = {
  title: "Privacy Policy — SC2 Tools",
  description:
    "How SC2 Tools collects, processes, and stores StarCraft II replay metadata.",
};

const LAST_UPDATED = "May 4, 2026";

export default function PrivacyPage() {
  return (
    <article className="prose prose-invert mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p className="text-text-muted">Last updated: {LAST_UPDATED}</p>
      </header>

      <p>
        SC2 Tools is a free, donation-supported analytics tool for StarCraft II
        players. This policy explains what data we collect, why, and how you
        can exercise your rights over it.
      </p>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">What we collect</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account identity.</strong> Your Clerk user id, email, and
            (if you signed in with Google) your Google account name and avatar.
            We do not see your Google password.
          </li>
          <li>
            <strong>Replay metadata.</strong> Each .SC2Replay file you produce
            in your local Replays folder is parsed by the SC2 Tools agent
            running on your PC. We upload structured metadata: map name, race
            matchup, build orders, APM, MMR, opponent battle tag and SC2 pulse
            ID. We never upload the .SC2Replay file itself.
          </li>
          <li>
            <strong>Personal builds and notes.</strong> Anything you type into
            the build editor.
          </li>
          <li>
            <strong>Device fingerprints.</strong> When you pair an agent we
            store a hashed device token, the agent version, and the OS string.
          </li>
          <li>
            <strong>Operational telemetry.</strong> Standard request logs (IP,
            user-agent, timestamp), retained for 30 days for security and
            debugging. If Sentry crash reporting is enabled (opt-in via
            settings), unhandled exceptions are forwarded to Sentry with PII
            scrubbed.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">What we do NOT collect</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>The contents of your replay files.</li>
          <li>Anything from outside your Replays folder.</li>
          <li>Voice or video.</li>
          <li>Payment information (we don&apos;t take payments).</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Where the data lives</h2>
        <p>
          MongoDB Atlas (US-East), Render (US-East), Vercel (US/EU edge for the
          static site, US-East for server functions). All connections are
          TLS-encrypted. Database backups run nightly with 7-day retention.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Sharing</h2>
        <p>
          We do not sell or rent your data. We share it only with the
          subprocessors above (Clerk for auth, MongoDB Atlas for database
          hosting, Render for API hosting, Vercel for the website, Sentry for
          opt-in crash reporting).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Aggregated opponent data</h2>
        <p>
          When you publish a build to the community, or when we display
          aggregated opponent stats on a public profile, we strip names and
          apply k-anonymity (we never publish a row that fewer than 5 unique
          users have contributed to). Pulse IDs are public information from
          Blizzard&apos;s ladder.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Your rights</h2>
        <p>
          You can export every byte of your data as a JSON archive, or delete
          your account permanently, from{" "}
          <a href="/settings" className="underline">
            Settings → Backups → Export / delete (GDPR)
          </a>
          . Deletion is hard — there is no recovery. If you live in the EU, UK,
          or California, you have additional rights under GDPR and CCPA; open a
          ticket at{" "}
          <a
            href="https://github.com/ReSpOnSeSC2/sc2tools/issues"
            rel="noopener"
            className="underline"
          >
            github.com/ReSpOnSeSC2/sc2tools/issues
          </a>{" "}
          to exercise them.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Cookies</h2>
        <p>
          We use cookies for session login (Clerk), CSRF protection, and a
          single &quot;cookie consent&quot; cookie that records whether
          you&apos;ve seen this banner. We do NOT use advertising or tracking
          cookies.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Children</h2>
        <p>
          SC2 Tools is not directed at children under 13. If you believe a
          child has signed up, open a ticket at{" "}
          <a
            href="https://github.com/ReSpOnSeSC2/sc2tools/issues"
            rel="noopener"
            className="underline"
          >
            github.com/ReSpOnSeSC2/sc2tools/issues
          </a>{" "}
          and we will delete the account.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Changes to this policy</h2>
        <p>
          When we make material changes, we&apos;ll bump the &quot;last
          updated&quot; date and surface a banner on next sign-in.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          <a
            href="https://github.com/ReSpOnSeSC2/sc2tools/issues"
            rel="noopener"
            className="underline"
          >
            github.com/ReSpOnSeSC2/sc2tools/issues
          </a>
        </p>
      </section>
    </article>
  );
}
