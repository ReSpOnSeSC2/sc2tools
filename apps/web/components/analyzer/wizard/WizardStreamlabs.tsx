"use client";

export function WizardStreamlabs() {
  return (
    <div className="space-y-3 text-sm text-text-muted">
      <h2 className="text-lg font-semibold text-text">Donations</h2>
      <p>
        SC2 Tools is donation-funded. There&rsquo;s no paid tier, no
        feature gates, and no ads. If the tool helps your stream, dropping
        a tip via Streamlabs keeps the lights on.
      </p>
      <a
        className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors border border-border bg-bg-elevated text-text hover:bg-bg-subtle"
        href="https://streamlabs.com/sc2tools/tip"
        target="_blank"
        rel="noopener noreferrer"
      >
        Tip via Streamlabs
      </a>
    </div>
  );
}
