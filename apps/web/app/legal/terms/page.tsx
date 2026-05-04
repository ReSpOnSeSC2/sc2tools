export const metadata = {
  title: "Terms of Service — SC2 Tools",
  description: "Terms governing use of SC2 Tools.",
};

const LAST_UPDATED = "May 4, 2026";

export default function TermsPage() {
  return (
    <article className="prose prose-invert mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Terms of Service</h1>
        <p className="text-text-muted">Last updated: {LAST_UPDATED}</p>
      </header>

      <p>
        SC2 Tools is provided free of charge as a community service. By using
        it, you accept these terms.
      </p>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">1. The service</h2>
        <p>
          We parse the StarCraft II replays your local agent finds and present
          you with analytics. We are not affiliated with, endorsed by, or
          sponsored by Blizzard Entertainment. StarCraft II is a trademark of
          Blizzard Entertainment.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">2. Your account</h2>
        <p>
          You&apos;re responsible for the security of your sign-in credentials.
          One human, one account; bot accounts and ladder-spoofing accounts
          will be banned without notice.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">3. Acceptable use</h2>
        <p>
          You will not (a) try to scrape or extract data about other users, (b)
          publish a build that contains profanity or harassment, (c) abuse the
          API or overlay endpoints, or (d) try to circumvent the agent&apos;s
          replay-folder constraints. We may suspend accounts that breach these
          rules.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">4. Donations</h2>
        <p>
          SC2 Tools accepts voluntary donations through Streamlabs. Donations
          are gifts, not purchases — they do not entitle the donor to any
          specific feature or service level.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">5. Content you post</h2>
        <p>
          When you publish a build, comment, or other content to the community,
          you grant SC2 Tools a non-exclusive, royalty-free licence to display
          and distribute it through the service. You retain ownership; you can
          retract published content from{" "}
          <a href="/builds" className="underline">
            /builds
          </a>{" "}
          at any time.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">6. Termination</h2>
        <p>
          You can delete your account at any time. We may close accounts that
          breach these terms or for prolonged inactivity (24 months). On
          deletion every per-user record is permanently removed.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">7. Warranties</h2>
        <p>
          The service is provided &quot;as is&quot;. We make no guarantees that
          analytics are accurate, that uploads will always succeed, or that
          the service will remain available. We are not responsible for any
          loss of MMR, sleep, or self-esteem caused by what the analyzer says
          about your micro.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">8. Liability</h2>
        <p>
          To the extent permitted by law, our liability for any claim arising
          out of your use of the service is capped at the amount you have paid
          us in the prior 12 months. Since the service is free, that cap is
          $0.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">9. Changes</h2>
        <p>
          We may update these terms; when we do, we&apos;ll bump the &quot;last
          updated&quot; date and notify signed-in users on next visit. Material
          changes that reduce your rights take effect 30 days after notice.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">10. Governing law</h2>
        <p>
          These terms are governed by the laws of the State of Delaware, USA.
          Disputes are resolved in the state or federal courts in Delaware.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p>
          <a href="mailto:hello@sc2tools.app" className="underline">
            hello@sc2tools.app
          </a>
        </p>
      </section>
    </article>
  );
}
