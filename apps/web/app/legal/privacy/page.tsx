/**
 * /legal/privacy — the SC2 Tools privacy policy (static server component).
 *
 * Each policy section is its own small component, so the page reads top to
 * bottom like the policy and no function outgrows the engineering limits.
 * Update `LAST_UPDATED` whenever the policy text changes materially.
 *
 * Example:
 *   GET /legal/privacy  →  <PrivacyPage />
 */
import { BackupRetention } from "@/components/legal/BackupRetention";
import type { ReactNode } from "react";
import Link from "next/link";
import { LegalLayout, LegalHeading, legalSectionId } from "@/components/legal/LegalLayout";
import { CookieSettingsButton } from "@/components/legal/CookieSettingsButton";
import { ISSUES_URL } from "@/lib/siteLinks";

export const metadata = {
  alternates: { canonical: "/legal/privacy" },
  title: "Privacy Policy",
  description:
    "How SC2 Tools processes replay data, connected streaming accounts, and private StarCraft II replay files.",
};

const LAST_UPDATED = "2026-10-23";
/** Settings tab with export, history deletion and account deletion. */
const DATA_SETTINGS_HREF = "/settings?tab=backups";
const LIST_CLASS = "list-disc space-y-2 pl-6";

/**
 * The privacy policy page.
 *
 * Example:
 *   <PrivacyPage />
 */
export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated={LAST_UPDATED} sections={[{"id":"what-we-collect","title":"What we collect"},{"id":"what-we-do-not-collect","title":"What we do NOT collect"},{"id":"where-the-data-lives","title":"Where the data lives"},{"id":"backups","title":"Backups"},{"id":"connected-accounts-and-stream-controls","title":"Connected accounts and stream controls"},{"id":"data-stored-in-your-browser","title":"Data stored in your browser"},{"id":"sharing","title":"Sharing"},{"id":"community-publishing","title":"Community publishing"},{"id":"aggregated-opponent-data","title":"Aggregated opponent data"},{"id":"your-rights","title":"Your rights"},{"id":"cookies","title":"Cookies"},{"id":"children","title":"Children"},{"id":"changes-to-this-policy","title":"Changes to this policy"},{"id":"contact","title":"Contact"}]} summary={<div className="mb-8 rounded-xl border border-border bg-bg-elevated p-5"><h2 className="text-h3 font-semibold">The short version</h2><ul className="mt-3 list-disc space-y-2 pl-5"><li>We process replay data, account details and streaming accounts you connect.</li><li>We do not sell your data or use advertising trackers.</li><li>Google Analytics runs only if you opt in.</li><li>Export your data or delete your account in Settings → Backups &amp; data.</li><li>Contact us through the issue tracker linked below.</li></ul></div>}>

      <p>
        SC2 Tools is a free, donation-supported analytics and streaming tool for StarCraft II
        players. This policy explains what data we collect, why, and how you
        can exercise your rights over it.
      </p>

      <WhatWeCollect />
      <WhatWeDoNotCollect />
      <WhereDataLives />
      <Backups />
      <ConnectedStreamAccounts />
      <BrowserStoredData />
      <Sharing />
      <CommunityPublishing />
      <AggregatedOpponentData />
      <YourRights />
      <Cookies />
      <Children />
      <PolicyChanges />
      <Contact />
    </LegalLayout>
  );
}

function PolicySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <LegalHeading id={legalSectionId(title)}>{title}</LegalHeading>
      {children}
    </section>
  );
}

function IssuesLink() {
  return (
    <a href={ISSUES_URL} rel="noopener" className="underline">
      github.com/ReSpOnSeSC2/sc2tools/issues
    </a>
  );
}

function DataSettingsLink() {
  return (
    <Link href={DATA_SETTINGS_HREF} className="underline">
      Settings → Backups &amp; data
    </Link>
  );
}

function TryPath() {
  return <code className="font-mono">/try</code>;
}

function WhatWeCollect() {
  return (
    <PolicySection title="What we collect">
      <ul className={LIST_CLASS}>
        <AccountAndReplayItems />
        <ConnectedAccountItem />
        <InstantAnalysisItem />
        <BuildsDeviceAndTelemetryItems />
        <PresenceAndAnalyticsItems />
      </ul>
    </PolicySection>
  );
}

function AccountAndReplayItems() {
  return (
    <>
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
    </>
  );
}

function InstantAnalysisItem() {
  return (
    <li>
      <strong>Instant Analysis (in your browser).</strong> Instant
      Analysis reads the replays or replay folder you choose and parses
      them on your device, inside your browser. The analyzer is served
      from our own site, not a third-party service. On the <TryPath />{" "}
      page your report is built and kept in your browser, and nothing is
      uploaded unless you choose to save the games to an account. When you
      save or import games while signed in, or Folder Sync uploads new
      games, we receive the same parsed game data the agent sends. When our
      replay archive is enabled, a signed-in import also uploads the
      original replay files to it, like the agent does; the import shows
      this as a checkbox, checked by default, that you can clear before you
      start. Folder Sync never uploads original files. If you opted in to
      usage analytics, Instant Analysis reports only counts, timings, error
      types, and how files were added (for example, drag and drop), never
      file names, player names, or replay contents.
    </li>
  );
}

function ConnectedAccountItem() {
  return (
    <li>
      <strong>Connected streaming accounts.</strong> If you connect YouTube,
      Twitch, or Kick, we receive the provider account or channel ID, displayed
      name, approved permissions, and authorization tokens. Enabled features
      read notification events and stream metadata. If you separately connect
      stream controls, we process the titles, descriptions, broadcast settings,
      and stream identifiers needed for the controls you use.
    </li>
  );
}

function BuildsDeviceAndTelemetryItems() {
  return (
    <>
      <li>
        <strong>Personal builds and notes.</strong> Anything you type into
        the build editor.
      </li>
      <li>
        <strong>Device fingerprints.</strong> When you pair an agent we
        store a hashed device token, the agent version, and the OS string.
      </li>
      <li>
        <strong>Account setup and support.</strong> Signed-in installer hand-offs,
        pairing, saved game counts and an observed visit during the second week
        after signup help us diagnose setup problems. These first-party account
        milestones are separate from optional Google Analytics. Administrator
        actions are retained for up to 400 days with allowlisted result counters;
        account deletion anonymizes their account identifiers. Background-job
        history contains no user identifiers and is capped at 5,000 records.
      </li>
      <li>
        <strong>Operational telemetry.</strong> Standard request logs (IP,
        user-agent, timestamp), retained for 30 days for security and
        debugging. If Sentry crash reporting is enabled (opt-in via
        settings), unhandled exceptions are forwarded to Sentry with PII
        scrubbed.
      </li>
    </>
  );
}

function PresenceAndAnalyticsItems() {
  return (
    <>
      <li>
        <strong>Live community counts.</strong> To show how many visitors
        are currently active, the site sends a brief presence check while
        you are using a visible page. A short-lived first-party cookie
        groups visits from the same browser; signed-in accounts are counted
        once across devices using a keyed hash of the account ID. Presence
        records contain hashed identifiers and activity timestamps, with
        no page history, email, or location. Records stop counting after
        three minutes and are automatically removed shortly afterward.
        Only aggregate counts are public. Agent activity comes from recent
        check-ins, and download counts come from recorded installer requests.
      </li>
      <li>
        <strong>Usage analytics (opt-in).</strong> Only if you click
        &quot;Accept&quot; on the cookie banner, we load Google Analytics 4
        to understand which pages and features get used. It records
        pseudonymous data such as pages viewed, approximate location
        (country/region, from a truncated IP), device type, and referring
        site. We enable IP anonymization and disable advertising signals.
        Google Analytics does not load until you opt in, and you can
        withdraw consent at any time by clicking &quot;Reject&quot; on the
        banner (clear the banner choice in your browser storage to see it
        again).
      </li>
    </>
  );
}

function WhatWeDoNotCollect() {
  return (
    <PolicySection title="What we do NOT collect">
      <ul className={LIST_CLASS}>
        <li>Unrelated files on your computer.</li>
        <li>Voice or video.</li>
        <li>Payment information (we don&apos;t take payments).</li>
      </ul>
    </PolicySection>
  );
}

function WhereDataLives() {
  return (
    <PolicySection title="Where the data lives">
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
    </PolicySection>
  );
}

function Backups() {
  return (
    <PolicySection title="Backups">
      <BackupRetention />
      <ul className={LIST_CLASS}>
        <li>
          <strong>Service database backups.</strong> MongoDB Atlas keeps whole-database snapshots under our configured backup schedule. They are encrypted and used to recover the service after failures. They are not a way to restore one account on request.
        </li>
        <li>
          <strong>Snapshots you take.</strong> A snapshot you take in{" "}
          <DataSettingsLink /> is a copy of your own account data, stored in
          private Cloudflare R2 storage. We retain up to 5 manual snapshots,
          2 weekly automatic snapshots, and 3 snapshots taken before destructive
          data actions. Older copies in each category expire as new ones are
          taken. All private snapshots are removed when you delete your account.
          Snapshots do not contain original replay files or replay-detail payloads.
        </li>
        <li>
          <strong>Your export.</strong> The JSON export is the copy you keep
          yourself. We do not keep a copy of the file you download.
        </li>
      </ul>
      <p>
        Original replay files and replay-detail payloads in Cloudflare R2
        are not part of the database backups. When you delete data or your
        account, it is removed from the live database and from R2 straight
        away. Copies already inside database backups are not edited; they
        are deleted when those backups expire.
      </p>
    </PolicySection>
  );
}

function ConnectedStreamAccounts() {
  return (
    <PolicySection title="Connected accounts and stream controls">
      <p>
        Account connections are optional. Notification connections keep their
        existing permissions; stream controls require separate approval.
        YouTube stream controls read your channel and reusable stream names and
        IDs, prepare horizontal and vertical broadcasts, bind them to your
        selected streams, and update their titles, descriptions, and settings.
        Twitch and Kick controls update and verify stream titles. The YouTube
        permission has a broad provider description, but these controls do not
        delete your videos or past broadcasts.
      </p>
      <p>
        For the normal SC2Tools account connection, access and refresh tokens
        are encrypted in the server&apos;s account vault in MongoDB Atlas.
        The desktop agent uses its paired SC2Tools account to request controls;
        these provider tokens and the server&apos;s application secrets are
        not sent to the agent or OBS. We do not receive your provider password
        or livestream audio or video through these controls. OBS passwords and
        stream keys remain in OBS or your local configuration. The advanced
        local OAuth setup uses your own application credentials instead;
        credentials saved by that Windows agent are protected with Windows
        per-user encryption and remain on your computer.
      </p>
      <p>
        To avoid creating duplicate YouTube broadcasts after a timeout or
        restart, we store creation request IDs, requested titles, descriptions
        and settings, channel and broadcast identifiers, selected stream IDs,
        operation outcomes, and quota records. Daily quota counters expire
        automatically. Creation and request-ID records remain until you delete
        your SC2Tools account and its data; they are not included in account
        export or restore because restoring them could repeat an operation.
      </p>
      <p>
        Disconnecting an account in Settings removes its saved server
        authorization and stops future controls through that connection. We
        also attempt to revoke authorization with the provider; if that
        provider is unavailable, you can remove access in its account settings.
        Disconnecting keeps the creation records described above and does not
        delete or undo anything already published on YouTube, Twitch, or Kick.
        Local credentials from the advanced setup must be removed from that
        agent separately. Deleting your SC2Tools account through{" "}
        <DataSettingsLink /> removes its server connections and creation
        records. Deleting only replay history does not remove them.
      </p>
    </PolicySection>
  );
}

function BrowserStoredData() {
  return (
    <PolicySection title="Data stored in your browser">
      <p>
        Instant Analysis keeps some data in your browser&apos;s IndexedDB
        storage on your device. We cannot read it, and it is sent to us only
        when you save your <TryPath /> games to an account:
      </p>
      <BrowserStoredItems />
      <p>
        To remove this data, use <strong>Clear local data</strong> on the{" "}
        <TryPath /> page (for the analyzed games), or on the Folder Sync card{" "}
        <strong>Stop syncing</strong> (Chrome and Edge) or{" "}
        <strong>Forget import history</strong> (other browsers) for the folder
        permission and the ledger, or clear this site&apos;s data in your
        browser settings to remove all of it. This does not delete games you
        already saved to your account. To delete those, use{" "}
        <DataSettingsLink />.
      </p>
    </PolicySection>
  );
}

function BrowserStoredItems() {
  return (
    <ul className={LIST_CLASS}>
      <li>
        <strong>Games analyzed on /try.</strong> The parsed game data (at
        most the 100 most recently analyzed games), so you can come back to
        your report or save the games after signing up. Each game expires 7
        days after it was analyzed and is deleted the next time you open{" "}
        <TryPath /> in that browser. Saving the games to your account also
        deletes them from the browser.
      </li>
      <li>
        <strong>Folder Sync ledger.</strong> If you use Folder Sync or import
        a whole folder, a list of the replay files it has handled: each
        file&apos;s path within the folder you picked, its size and modified
        date, whether it was uploaded, skipped, or failed, and the game it
        matched. For a replay where it couldn&apos;t tell which player is
        you, it also keeps the players&apos; StarCraft II account IDs, so
        the file is checked again once your profile knows one of them.
        Later scans and imports use it to skip files that are already done.
      </li>
      <li>
        <strong>Folder permission.</strong> The browser&apos;s read-only
        handle to the folder you picked for Folder Sync, the time of the
        last scan, which account set it up and, once the daily browser
        upload limit is reached, when it may sync again. Folder Sync only
        ever syncs into that account: if someone else signs in on the same
        browser, nothing is synced until they choose to use the folder for
        their own account, which first forgets the previous account&apos;s
        ledger. Your browser may ask you to allow access again on a later
        visit.
      </li>
    </ul>
  );
}

function Sharing() {
  return (
    <PolicySection title="Sharing">
      <p>
        We do not sell or rent your data. Services that operate SC2 Tools
        process it as described above (Clerk for auth, MongoDB Atlas for database
        hosting, Cloudflare R2 for private replay-file storage, Render for
        API hosting, Vercel for the website, Sentry for opt-in crash
        reporting, and Google Analytics for opt-in usage analytics). If you
        connect stream controls, we also send the metadata and control requests
        you choose to the connected provider. Stream titles, descriptions,
        and broadcasts may appear on that service according to the visibility
        and streaming settings you choose.
      </p>
    </PolicySection>
  );
}

function CommunityPublishing() {
  return (
    <PolicySection title="Community publishing">
      <p>
        Publishing a build is optional and user-controlled. Community builds
        show your profile or chosen community name by default; you can
        explicitly choose <strong>Post anonymously</strong> for an individual
        build. We publish its title, description, build metadata, and
        signature, but not source replays, opponent identities, or personal
        notes. You can remove the listing from Community at any time.
      </p>
    </PolicySection>
  );
}

function AggregatedOpponentData() {
  return (
    <PolicySection title="Aggregated opponent data">
      <p>
        Public aggregated opponent statistics are a separate feature. We
        strip contributor names and apply k-anonymity: we never publish an
        aggregate row that fewer than 5 unique users have contributed to.
        Pulse IDs are public information from Blizzard&apos;s ladder.
      </p>
    </PolicySection>
  );
}

function YourRights() {
  return (
    <PolicySection title="Your rights">
      <p>You can export your structured account data as JSON, download original replay files from replay history, or delete your replay history or account from <DataSettingsLink />. The deletion dialog shows a live inventory before you confirm.</p>
      <ul className={LIST_CLASS}>
        <li>Account deletion removes your profile, preferences, games and analysis, original replay and playback files, notes, custom and published builds, devices, overlay links, Stream Studio and viewer records, sounds, connected streaming credentials, notifications, private snapshots and coaching relationships.</li>
        <li>Your review requests and their threads are deleted. Comments you wrote on other people&apos;s requests remain with the author shown as [deleted user]. Service activity records lose their account identifiers; private support message text and replies are removed.</li>
        <li>We delete your sign-in identity after the live data purge. Provider failures leave a minimal retry record until deletion succeeds. Completed deletion keeps only a keyed guard for 30 days to reject old sessions and late identity events.</li>
      </ul>
      <BackupRetention />
      <p>Copies already inside database backups are not edited individually. To ask about access, correction or deletion rights, contact us at <IssuesLink />.</p>
    </PolicySection>
  );
}

function Cookies() {
  return (
    <PolicySection title="Cookies">
      <p>You can change your choice any time from Cookie settings here or in the site footer.</p>
      <CookieSettingsButton />
      <p>
        The site uses cookies for session login (Clerk), CSRF protection,
        and a short-lived first-party presence token for the public users
        online count. The presence cookie expires after three minutes
        without an activity check. Your banner choice is stored in your
        browser&apos;s local storage, not a cookie.
      </p>
      <p>
        If — and only if — you opt in via the banner, Google Analytics sets
        its own first-party analytics cookies (e.g.{" "}
        <code className="font-mono">_ga</code>) to measure usage. These are
        never set before you accept, and we do NOT use advertising or
        cross-site tracking cookies.
      </p>
    </PolicySection>
  );
}

function Children() {
  return (
    <PolicySection title="Children">
      <p>
        SC2 Tools is not directed at children under 13. If you believe a
        child has signed up, open a ticket at <IssuesLink /> and we will
        delete the account.
      </p>
    </PolicySection>
  );
}

function PolicyChanges() {
  return (
    <PolicySection title="Changes to this policy">
      <p>
        When we make material changes, we update the &quot;last updated&quot;
        date and provide additional notice when required by applicable law
        or when a change materially affects how we use personal data.
      </p>
    </PolicySection>
  );
}

function Contact() {
  return (
    <PolicySection title="Contact">
      <p>
        <IssuesLink />
      </p>
    </PolicySection>
  );
}
