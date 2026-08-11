export const metadata = {
  alternates: { canonical: "/legal/privacy" },
  title: "Privacy Policy — SC2 Tools",
  description:
    "How SC2 Tools processes replay data and stores private StarCraft II replay files.",
};

const LAST_UPDATED = "August 11, 2026";

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
            <strong>Replay data and original files.</strong> Each .SC2Replay
            file in a replay folder you add is read by the SC2 Tools agent on
            your PC. The agent uploads structured data such as map, matchup,
            build orders, APM, MMR, opponent identity, and the original replay
            file. Originals are kept in a private cloud archive so you can
            download your own replays from the dashboard.
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
          <li>
            <strong>Usage analytics (opt-in).</strong> Only if you click
            &quot;Accept&quot; on the cookie banner, we load Google Analytics 4
            to understand which pages and features get used. It records
            pseudonymous data such as pages viewed, approximate location
            (country/region, from a truncated IP), device type, and referring
            site. We enable IP anonymization and disable advertising signals.
            Nothing analytics-related loads until you opt in, and you can
            withdraw consent at any time by clicking &quot;Reject&quot; on the
            banner (clear the banner choice in your browser storage to see it
            again).
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">What we do NOT collect</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>Anything from outside your Replays folder.</li>
          <li>Voice or video.</li>
          <li>Payment information (we don&apos;t take payments).</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Where the data lives</h2>
        <p>
          Structured replay data lives in MongoDB Atlas. Original replay files
          and larger replay-detail payloads live in a private Cloudflare R2
          bucket. Render hosts the API, and Vercel hosts the website. Data is
          sent over TLS; access to replay downloads requires your signed-in
          account and a short-lived private download link.
        </p>
        <p>
          Replay files remain stored until you delete the matching history or
          your account. Temporary download links expire after a short period
          and do not make the bucket public. Incomplete temporary uploads are
          not exposed in your library and are covered by a one-day automatic
          expiration rule.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Sharing</h2>
        <p>
          We do not sell or rent your data. We share it only with the
          subprocessors above (Clerk for auth, MongoDB Atlas for database
          hosting, Cloudflare R2 for private replay-file storage, Render for
          API hosting, Vercel for the website, Sentry for opt-in crash
          reporting, and Google Analytics for opt-in usage analytics).
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
          You can export your structured account data as a JSON archive,
          download stored replay originals from replay history, or delete your
          replay history or account permanently from{" "}
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
          By default we use only strictly-necessary cookies: session login
          (Clerk) and CSRF protection. Your banner choice is stored in your
          browser&apos;s local storage, not a cookie.
        </p>
        <p>
          If — and only if — you opt in via the banner, Google Analytics sets
          its own first-party analytics cookies (e.g.{" "}
          <code className="font-mono">_ga</code>) to measure usage. These are
          never set before you accept, and we do NOT use advertising or
          cross-site tracking cookies.
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
