import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="space-y-12">
      <section className="space-y-5 py-12">
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Real opponent intel for StarCraft II — no install, no fuss.
        </h1>
        <p className="max-w-2xl text-lg text-text-muted">
          Sign in, run a 15&nbsp;MB agent on your PC, and every replay you
          finish appears in the analyzer in seconds. Pop your hosted
          overlay URL into OBS and stream-day prep is one Browser
          Source.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/sign-up" className="btn">
            Get started — it&apos;s free
          </Link>
          <Link href="/download" className="btn btn-secondary">
            Download the agent
          </Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <FeatureCard
          title="Opponents tab in seconds"
          body="Background syncing — no more 30-second blank screen while replays parse on first load."
        />
        <FeatureCard
          title="Live OBS overlay"
          body="One URL into Browser Source. Opponent dossier pops on game start."
        />
        <FeatureCard
          title="Cross-device"
          body="Laptop, second monitor, phone. All synced via your Google sign-in."
        />
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-xl font-semibold">How it works</h2>
        <ol className="list-decimal space-y-2 pl-6 text-text-muted">
          <li>Sign in with Google.</li>
          <li>
            Download the SC2 Tools Agent (a single 15&nbsp;MB executable).
            It auto-detects your Replays folder.
          </li>
          <li>
            Pair the agent with this account by typing the 6-digit code
            it shows on first run.
          </li>
          <li>
            Play. Every finished replay parses and uploads in the
            background.
          </li>
        </ol>
      </section>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      <p className="text-text-muted">{body}</p>
    </div>
  );
}
