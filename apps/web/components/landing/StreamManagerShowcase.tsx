import Link from "next/link";
import {
  ArrowRight,
  Check,
  Link2,
  MonitorPlay,
  Radio,
  Repeat2,
  Smartphone,
  Type,
  Video,
  Youtube,
} from "lucide-react";

const FEATURES = [
  {
    number: "01",
    icon: Repeat2,
    title: "Keep your keys. Refresh your sessions.",
    body: "Prepare fresh horizontal and vertical YouTube broadcasts on your saved stream keys. After both broadcasts finish, the next pair can be prepared automatically.",
  },
  {
    number: "02",
    icon: Type,
    title: "One title, across your channels.",
    body: "Connect your accounts once, then update both YouTube broadcasts, Twitch and Kick from one title field in the desktop agent.",
  },
  {
    number: "03",
    icon: Link2,
    title: "Give every viewer a way to connect.",
    body: "Your portrait description links to the current horizontal broadcast. Saved website and social links carry into each new YouTube session.",
  },
] as const;

/** Public preview of the desktop stream manager, separate from released overlays. */
export function StreamManagerShowcase({
  id = "stream-sessions",
  className = "",
}: {
  id?: string;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`scroll-mt-24 overflow-hidden rounded-xl border border-border-strong bg-bg-surface ${className}`}
    >
      <div className="h-1 bg-accent-cyan" aria-hidden />
      <div className="grid items-center gap-8 p-5 sm:p-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-10 lg:p-10">
        <div className="min-w-0">
          <p className="inline-flex flex-wrap items-center gap-2 text-micro font-semibold uppercase tracking-[0.1em]">
            <Radio className="h-4 w-4 text-accent-cyan" aria-hidden />
            <span className="text-accent-cyan">Stream Studio preview</span>
            <span className="rounded border border-border-strong px-2 py-1 text-text-muted">Agent 0.18</span>
          </p>
          <h2
            id={`${id}-title`}
            className="mt-5 font-display text-[30px] font-bold leading-[1.1] tracking-tight text-text sm:text-[38px]"
          >
            One title.<br />
            Both YouTube formats.<br />
            <span className="text-accent-cyan">Your next session, ready.</span>
          </h2>
          <p className="mt-5 max-w-lg text-body-lg text-text-muted">
            A dedicated Streams workspace brings your titles, connected accounts
            and YouTube sessions together, alongside the OBS setup you already use.
          </p>
          <p className="mt-5 border-l-2 border-accent-cyan/40 pl-4 text-caption text-text-muted">
            Coming with desktop agent 0.18. The current public download includes
            the existing overlays and Stream Dock.
          </p>
          <Link
            href="/download"
            className="mt-5 inline-flex min-h-11 items-center gap-2 text-body font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Explore the desktop agent
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
        <SessionWorkspace />
      </div>

      <div className="grid border-t border-border md:grid-cols-3">
        {FEATURES.map(({ number, icon: Icon, title, body }) => (
          <article
            key={number}
            className="min-w-0 border-b border-border p-5 last:border-b-0 sm:p-6 md:border-b-0 md:border-r md:last:border-r-0 lg:p-8"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-micro text-text-dim">{number}</span>
              <Icon className="h-5 w-5 text-accent-cyan" aria-hidden />
            </div>
            <h3 className="mt-4 text-body-lg font-semibold leading-snug text-text">{title}</h3>
            <p className="mt-3 text-caption text-text-muted">{body}</p>
          </article>
        ))}
      </div>

      <div className="grid gap-5 border-t border-border bg-bg-elevated/60 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10 lg:px-8">
        <div className="flex min-w-0 gap-3">
          <MonitorPlay className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden />
          <div>
            <h3 className="text-body font-semibold text-text">Keep your OBS controls</h3>
            <p className="mt-1 text-caption text-text-muted">
              Prepare your YouTube sessions in SC2 Tools, then start your outputs
              with the OBS or Aitum broadcast buttons.
            </p>
          </div>
        </div>
        <div className="flex min-w-0 gap-3">
          <Video className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden />
          <div>
            <h3 className="text-body font-semibold text-text">TikTok, in landscape too</h3>
            <p className="mt-1 text-caption text-text-muted">
              Send OBS's main virtual camera to TikTok LIVE Studio for horizontal
              video. Add your mic and game audio in Studio, then go live there.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function SessionWorkspace() {
  return (
    <figure className="min-w-0">
      <div className="overflow-hidden rounded-lg border border-border-strong bg-bg shadow-[0_16px_40px_rgba(0,0,0,0.12)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          <span className="flex items-center gap-2 text-caption font-semibold text-text">
            <Radio className="h-4 w-4 text-accent-cyan" aria-hidden />
            Streams
          </span>
          <span className="text-micro text-text-dim">Desktop workspace</span>
        </div>
        <div className="p-4 sm:p-5">
          <div className="rounded-md border border-border bg-bg-elevated p-3 sm:p-4">
            <p className="flex items-center gap-2 text-micro text-text-muted">
              <Type className="h-3.5 w-3.5" aria-hidden /> Shared title
            </p>
            <p className="mt-2 text-body font-semibold text-text">Ladder night · Every game tells a story</p>
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="Shared title destinations">
              {["YouTube", "Twitch", "Kick"].map((platform) => (
                <li key={platform} className="flex items-center gap-1.5 rounded border border-border-strong px-2 py-1 text-micro text-text-muted">
                  <Check className="h-3 w-3 text-accent-cyan" aria-hidden />
                  {platform}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-4 grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
            <CanvasDestination orientation="horizontal" />
            <CanvasDestination orientation="vertical" />
          </div>
          <div className="mt-4 flex items-start gap-2 border-t border-border pt-4 text-caption text-text-muted">
            <Repeat2 className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
            <span>Same stream keys. Fresh broadcast links each session.</span>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-micro text-text-dim">
        Illustrative workflow · two independent YouTube broadcasts
      </figcaption>
    </figure>
  );
}

function CanvasDestination({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const vertical = orientation === "vertical";
  const Icon = vertical ? Smartphone : MonitorPlay;
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-border bg-bg-surface p-3">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-micro font-semibold text-text">
        <Youtube className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
        YouTube
      </p>
      <p className="mt-1 text-caption text-text-muted">{vertical ? "Vertical" : "Horizontal"}</p>
      <div className="flex min-h-[136px] flex-1 items-center justify-center py-3" aria-hidden>
        <div className={`flex items-center justify-center rounded border border-accent-cyan/30 bg-accent-cyan/5 ${vertical ? "aspect-[9/16] h-28" : "aspect-video w-full"}`}>
          <Icon className="h-7 w-7 text-accent-cyan/70 sm:h-9 sm:w-9" />
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-micro font-semibold text-accent-cyan">
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Session ready
      </p>
    </div>
  );
}
