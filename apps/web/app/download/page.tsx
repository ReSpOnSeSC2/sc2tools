import Link from "next/link";

export const metadata = {
  title: "Download the agent · SC2 Tools",
};

export default function DownloadPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Download the SC2 Tools Agent</h1>
        <p className="max-w-2xl text-text-muted">
          The agent is a small, single-file Windows program. It watches
          your Replays folder, parses each finished game in the
          background, and syncs the result here.
        </p>
      </header>

      <section className="card space-y-4 p-6">
        <h2 className="text-xl font-semibold">Windows (recommended)</h2>
        <p className="text-text-muted">
          Until the signed binary is published, you can run the agent
          from source. Both flows produce identical results.
        </p>
        <div className="space-y-3">
          <h3 className="font-semibold">Run from source</h3>
          <pre className="overflow-x-auto rounded bg-bg-elevated p-4 text-sm">
            <code>{`# 1. Clone the repo
git clone https://github.com/ReSpOnSeSC2/sc2tools.git
cd sc2tools/apps/agent

# 2. Install Python deps
py -m pip install -r requirements.txt

# 3. Configure
copy .env.example .env
# Edit .env and set SC2TOOLS_API_BASE to your API URL

# 4. Run
py -m sc2tools_agent`}</code>
          </pre>
        </div>
        <p className="text-text-muted">
          On first run the agent prints a 6-digit pairing code. Enter it
          on the <Link href="/devices">Devices</Link> page to bind this
          machine to your account.
        </p>
      </section>

      <section className="card space-y-3 p-6">
        <h2 className="text-xl font-semibold">What does the agent do?</h2>
        <ul className="list-disc space-y-1 pl-6 text-text-muted">
          <li>Watches your StarCraft II Replays folder.</li>
          <li>
            Parses each new <code>.SC2Replay</code> with sc2reader
            (~150–500&nbsp;ms per replay).
          </li>
          <li>
            Runs the macro engine (with the chrono fix) to produce SQ,
            APM, and a per-build aggregate.
          </li>
          <li>
            Uploads the resulting JSON record to your account. The replay
            file itself never leaves your machine.
          </li>
        </ul>
      </section>
    </div>
  );
}
