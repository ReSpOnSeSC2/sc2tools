import Link from "next/link";
import { LegalLayout, LegalHeading, legalSectionId } from "@/components/legal/LegalLayout";
import { ISSUES_URL } from "@/lib/siteLinks";

export const metadata = {
  alternates: { canonical: "/legal/terms" },
  title: "Terms of Service",
  description: "Terms governing use of SC2 Tools.",
};

const LAST_UPDATED = "2026-08-11";

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated={LAST_UPDATED} sections={[{"title":"1. The service","id":"the-service"},{"title":"2. Your account","id":"your-account"},{"title":"3. Acceptable use","id":"acceptable-use"},{"title":"4. Donations","id":"donations"},{"title":"5. Content you post","id":"content-you-post"},{"title":"6. Termination","id":"termination"},{"title":"7. Warranties","id":"warranties"},{"title":"8. Liability","id":"liability"},{"title":"9. Changes","id":"changes"},{"title":"10. Governing law","id":"governing-law"},{"title":"Contact","id":"contact"}]}>

      <p>
        SC2 Tools is provided free of charge as a community service. By using
        it, you accept these terms.
      </p>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("1. The service")}>{"1. The service"}</LegalHeading>
        <p>
          We parse the StarCraft II replays your local agent finds and present
          you with analytics. The agent also stores originals in your private
          replay library so you can download them while they remain in your
          account. We are not affiliated with, endorsed by, or sponsored by
          Blizzard Entertainment. StarCraft II is a trademark of Blizzard
          Entertainment.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("2. Your account")}>{"2. Your account"}</LegalHeading>
        <p>
          You&apos;re responsible for the security of your sign-in credentials.
          One human, one account; bot accounts and ladder-spoofing accounts
          will be banned without notice.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("3. Acceptable use")}>{"3. Acceptable use"}</LegalHeading>
        <p>
          You will not (a) try to scrape or extract data about other users, (b)
          publish a build that contains profanity or harassment, (c) abuse the
          API or overlay endpoints, or (d) try to circumvent the agent&apos;s
          replay-folder constraints. We may suspend accounts that breach these
          rules.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("4. Donations")}>{"4. Donations"}</LegalHeading>
        <p>
          SC2 Tools accepts voluntary donations through Streamlabs. Donations
          are gifts, not purchases — they do not entitle the donor to any
          specific feature or service level.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("5. Content you post")}>{"5. Content you post"}</LegalHeading>
        <p>
          When you publish a build, comment, or other content to the community,
          you grant SC2 Tools a non-exclusive, royalty-free license to display
          and distribute it through the service. You retain ownership; you can
          retract published content from{" "}
          <Link href="/builds" className="underline">
            /builds
          </Link>{" "}
          at any time.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("6. Termination")}>{"6. Termination"}</LegalHeading>
        <p>
          You can delete your account at any time. We may close accounts that
          breach these terms or for prolonged inactivity (24 months). On
          deletion every per-user record is permanently removed.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("7. Warranties")}>{"7. Warranties"}</LegalHeading>
        <p>
          The service is provided &quot;as is&quot;. We make no guarantees that
          analytics are accurate, that uploads will always succeed, or that
          the service will remain available. We are not responsible for any
          loss of MMR, sleep, or self-esteem caused by what the analyzer says
          about your micro.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("8. Liability")}>{"8. Liability"}</LegalHeading>
        <p>
          To the extent permitted by law, our liability for any claim arising
          out of your use of the service is capped at the amount you have paid
          us in the prior 12 months. Since the service is free, that cap is
          $0.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("9. Changes")}>{"9. Changes"}</LegalHeading>
        <p>
          We may update these terms; when we do, we&apos;ll bump the &quot;last
          updated&quot; date and notify signed-in users on next visit. Material
          changes that reduce your rights take effect 30 days after notice.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("10. Governing law")}>{"10. Governing law"}</LegalHeading>
        <p>
          These terms are governed by the laws of the State of Delaware, USA.
          Disputes are resolved in the state or federal courts in Delaware.
        </p>
      </section>

      <section className="space-y-3">
        <LegalHeading id={legalSectionId("Contact")}>{"Contact"}</LegalHeading>
        <p>
          <a
            href={ISSUES_URL}
            rel="noopener"
            className="underline"
          >
            github.com/ReSpOnSeSC2/sc2tools/issues
          </a>
        </p>
      </section>
    </LegalLayout>
  );
}
