import Image from "next/image";
import {
  Archive,
  BellRing,
  ChartNoAxesCombined,
  CheckCircle2,
  CirclePlay,
  Eye,
  Film,
  Gamepad2,
  Maximize2,
  Mic2,
  Radio,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  Volume2,
} from "lucide-react";
import { PRODUCT_FACTS } from "@/lib/productFacts";

const REPLAY_FEED = [
  { time: "4:12", name: "Robotics Facility", side: "YOU", active: false },
  { time: "4:34", name: "Stimpack", side: "OPP", active: false },
  { time: "6:08", name: "Warp Prism", side: "YOU", active: true },
  { time: "6:19", name: "Combat Shields", side: "OPP", active: false },
  { time: "6:31", name: "Psi Storm", side: "YOU", active: false },
] as const;

const UNIT_MARKERS = [
  { src: "/icons/sc2/units/stalker.png", alt: "Stalker", left: "24%", top: "59%", size: "h-10 w-10 sm:h-12 sm:w-12" },
  { src: "/icons/sc2/units/zealot.png", alt: "Zealot", left: "34%", top: "49%", size: "h-9 w-9 sm:h-11 sm:w-11" },
  { src: "/icons/sc2/units/immortal.png", alt: "Immortal", left: "43%", top: "63%", size: "h-11 w-11 sm:h-14 sm:w-14" },
  { src: "/icons/sc2/units/marine.png", alt: "Marine", left: "66%", top: "39%", size: "h-8 w-8 sm:h-10 sm:w-10" },
  { src: "/icons/sc2/units/marauder.png", alt: "Marauder", left: "73%", top: "48%", size: "h-10 w-10 sm:h-12 sm:w-12" },
  { src: "/icons/sc2/units/medivac.png", alt: "Medivac", left: "78%", top: "29%", size: "h-11 w-11 sm:h-14 sm:w-14" },
] as const;

export function ReplayTheaterPreview({ priority = false }: { priority?: boolean }) {
  return (
    <figure className="min-w-0">
      <div className="replay-scope overflow-hidden rounded-md border-2 border-line bg-[#070a0f] shadow-hard">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-strong bg-bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <CirclePlay className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-caption font-bold text-text">Replay Theater</p>
              <p className="truncate text-micro text-text-dim">Alcyone LE · PvT · names hidden</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-micro text-text-muted">
            <span className="rounded-sm border border-border-strong px-2 py-1">PRODUCT PREVIEW</span>
            <Maximize2 className="h-4 w-4" aria-hidden />
          </div>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div
            className="relative min-h-[310px] overflow-hidden sm:min-h-[390px]"
            style={{
              backgroundImage:
                "radial-gradient(circle at 54% 56%, rgba(60,224,214,.12), transparent 24%), radial-gradient(circle at 72% 36%, rgba(255,107,107,.10), transparent 22%), repeating-linear-gradient(30deg, rgba(255,255,255,.025) 0 1px, transparent 1px 30px), repeating-linear-gradient(150deg, rgba(255,255,255,.02) 0 1px, transparent 1px 30px), linear-gradient(145deg, #151b20 0%, #090d12 58%, #171419 100%)",
            }}
          >
            <div className="absolute inset-[8%] rounded-[42%_58%_48%_52%] border border-white/10 bg-black/10 shadow-[inset_0_0_70px_rgba(0,0,0,.55)]" />
            <div className="absolute left-[9%] top-[11%] rounded-sm border border-accent-cyan/25 bg-black/50 px-2 py-1 text-micro font-semibold text-accent-cyan">
              YOU · 92 supply
            </div>
            <div className="absolute right-[8%] top-[11%] rounded-sm border border-danger/25 bg-black/50 px-2 py-1 text-micro font-semibold text-danger">
              OPP · 88 supply
            </div>

            {UNIT_MARKERS.map((unit) => (
              <span
                key={`${unit.alt}-${unit.left}`}
                className={`absolute -translate-x-1/2 -translate-y-1/2 ${unit.size}`}
                style={{ left: unit.left, top: unit.top }}
                title={unit.alt}
              >
                <Image
                  src={unit.src}
                  alt=""
                  width={76}
                  height={76}
                  priority={priority}
                  className="h-full w-full object-contain drop-shadow-[0_3px_7px_rgba(0,0,0,.9)]"
                />
              </span>
            ))}

            <div className="absolute left-[57%] top-[51%] h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-cyan/70 bg-accent-cyan/10 shadow-[0_0_24px_rgba(60,224,214,.32)] sm:h-28 sm:w-28">
              <div className="absolute inset-3 rounded-full border border-accent-cyan/40" />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-black/70 px-2 py-1 text-[9px] font-bold tracking-[.12em] text-accent-cyan">
                PSI STORM · 6:31
              </span>
            </div>

            <div className="absolute bottom-4 left-4 right-4 flex flex-wrap gap-2">
              {[
                "Terrain paths",
                "Exact spell casts",
                "Army value",
              ].map((label) => (
                <span key={label} className="rounded-sm border border-white/10 bg-black/65 px-2 py-1 text-micro text-text-muted">
                  {label}
                </span>
              ))}
            </div>
          </div>

          <aside className="border-t border-border-strong bg-bg-surface lg:border-l lg:border-t-0" aria-label="Replay build feed example">
            <div className="border-b border-border px-4 py-3">
              <p className="text-micro font-bold uppercase tracking-[.14em] text-text-dim">Build feed</p>
              <p className="mt-1 text-caption font-semibold text-text">Both players, second by second</p>
            </div>
            <ol className="divide-y divide-border">
              {REPLAY_FEED.map((event) => (
                <li key={`${event.time}-${event.name}`} className={`grid grid-cols-[2.6rem_2.3rem_1fr] items-center gap-2 px-4 py-3 ${event.active ? "bg-accent/12" : ""}`}>
                  <span className="font-mono text-micro tabular-nums text-text-dim">{event.time}</span>
                  <span className={`text-[9px] font-bold ${event.side === "YOU" ? "text-accent-cyan" : "text-danger"}`}>{event.side}</span>
                  <span className={`text-caption ${event.active ? "font-semibold text-text" : "text-text-muted"}`}>{event.name}</span>
                </li>
              ))}
            </ol>
          </aside>
        </div>

        <div className="border-t border-border-strong bg-bg-surface px-4 py-3">
          <div className="flex items-center gap-3">
            <CirclePlay className="h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
            <span className="font-mono text-micro tabular-nums text-text-muted">06:31</span>
            <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-subtle">
              <div className="h-full w-[58%] rounded-full bg-accent-cyan" />
              <span className="absolute left-[28%] top-0 h-full w-[8%] bg-warning" />
              <span className="absolute left-[51%] top-0 h-full w-[7%] bg-danger" />
            </div>
            <span className="font-mono text-micro tabular-nums text-text-dim">11:42</span>
            <Volume2 className="hidden h-4 w-4 text-text-dim sm:block" aria-hidden />
          </div>
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted">
        <span>Illustrative interface preview with sample data.</span>
        <span className="text-text-dim">3D units · fog of war · spells · fullscreen</span>
      </figcaption>
    </figure>
  );
}

const FINGERPRINT_TRACKS = [
  { label: "Build repertoire", value: 68, detail: "6.2 effective builds" },
  { label: "Pace", value: 82, detail: "Timing-window specialist" },
  { label: "Matchup edge", value: 61, detail: "+7.4 points vs PvT" },
] as const;

const TREND_BARS = [42, 58, 39, 67, 54, 76, 63, 84, 70, 92, 79, 88] as const;

export function ImprovementPreview() {
  return (
    <figure className="min-w-0 overflow-hidden rounded-md border-2 border-line bg-bg-surface shadow-hard">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <ChartNoAxesCombined className="h-4 w-4 text-accent-cyan" aria-hidden />
          <span className="text-caption font-bold text-text">Player Intelligence</span>
        </div>
        <span className="text-micro font-semibold uppercase tracking-[.12em] text-text-dim">Sample · PvT · All time</span>
      </div>

      <div className="grid lg:grid-cols-[1.08fr_.92fr] lg:divide-x lg:divide-border">
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="kicker">Skill Fingerprint</p>
              <h3 className="mt-2 font-serif text-[26px] font-semibold leading-tight text-text">Adaptive Timing Specialist</h3>
              <p className="mt-2 max-w-md text-caption text-text-muted">One reproducible archetype for this matchup, calibrated against real player windows.</p>
            </div>
            <span className="rounded-sm border border-editorial/35 bg-editorial/10 px-2.5 py-1 text-micro font-bold text-editorial">1 OF {PRODUCT_FACTS.fingerprintArchetypes}</span>
          </div>
          <dl className="mt-6 space-y-4">
            {FINGERPRINT_TRACKS.map((track) => (
              <div key={track.label}>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-caption font-semibold text-text">{track.label}</dt>
                  <dd className="text-micro text-text-dim">{track.detail}</dd>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-subtle">
                  <div className="h-full rounded-full bg-accent-cyan" style={{ width: `${track.value}%` }} />
                </div>
              </div>
            ))}
          </dl>
        </div>

        <div className="bg-bg-elevated/30 p-5 sm:p-6">
          <p className="kicker">Trends, with sharper filters</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Metric label="Best MMR day" value="+126" note="7–2 · 9 games" tone="good" />
            <Metric label="Toughest day" value="−84" note="3–6 · 9 games" tone="bad" />
          </div>
          <div className="mt-5 rounded-md border border-border bg-bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-micro font-bold uppercase tracking-[.12em] text-text-dim">MMR progression</p>
                <p className="mt-1 text-caption font-semibold text-text">Filtered to 8–16 minute games</p>
              </div>
              <span className="font-mono text-caption font-bold text-success">+214</span>
            </div>
            <div className="mt-4 flex h-24 items-end gap-1" aria-label="Sample rising MMR trend">
              {TREND_BARS.map((height, i) => (
                <span key={`${height}-${i}`} className="min-w-0 flex-1 rounded-t-sm bg-accent-cyan/70" style={{ height: `${height}%` }} />
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-bg-surface px-4 py-3">
            <div>
              <p className="text-caption font-semibold text-text">Opponent MMR 4,000–4,499</p>
              <p className="text-micro text-text-dim">Meaningful 500-point bracket</p>
            </div>
            <span className="font-mono text-h4 font-bold text-success">61.8%</span>
          </div>
        </div>
      </div>

      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
        <ProofPoint icon={Archive} title="Private replay vault" body="Download the original file anytime." />
        <ProofPoint icon={Video} title="VOD jumps" body="Open Twitch or YouTube at this game." />
        <ProofPoint icon={Eye} title="One opponent dossier" body="Aliases and characters stay together." />
      </div>
      <figcaption className="border-t border-border px-5 py-3 text-caption text-text-muted">
        Illustrative player-intelligence preview with sample data.
      </figcaption>
    </figure>
  );
}

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone: "good" | "bad" }) {
  return (
    <div className="rounded-md border border-border bg-bg-surface p-3">
      <p className="text-micro font-semibold uppercase tracking-[.1em] text-text-dim">{label}</p>
      <p className={`mt-1 font-mono text-h3 font-bold ${tone === "good" ? "text-success" : "text-danger"}`}>{value}</p>
      <p className="text-micro text-text-muted">{note}</p>
    </div>
  );
}

function ProofPoint({ icon: Icon, title, body }: { icon: typeof Archive; title: string; body: string }) {
  return (
    <div className="bg-bg-surface p-4">
      <div className="flex items-center gap-2 text-text">
        <Icon className="h-4 w-4 text-editorial" aria-hidden />
        <p className="text-caption font-bold">{title}</p>
      </div>
      <p className="mt-1 text-micro text-text-muted">{body}</p>
    </div>
  );
}

const GHOST_STEPS = [
  { time: "3:58", label: "Twilight Council", state: "done" },
  { time: "4:24", label: "Robotics Facility", state: "now" },
  { time: "4:52", label: "Warp Prism", state: "next" },
] as const;

export function PracticePreview() {
  return (
    <figure className="overflow-hidden rounded-md border-2 border-line bg-bg-surface shadow-hard">
      <div className="grid lg:grid-cols-[1.05fr_.95fr]">
        <div className="border-b border-border p-5 sm:p-6 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="kicker">Ghost Build coach</p>
              <h3 className="mt-2 font-serif text-[26px] font-semibold text-text">Practice the timing, not the notes.</h3>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-success/30 bg-success/10 px-2.5 py-1 text-micro font-bold text-success">
              <Mic2 className="h-3.5 w-3.5" aria-hidden /> LIVE COACH
            </span>
          </div>

          <div className="mt-5 rounded-md border border-border bg-bg-elevated/50 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-caption font-bold text-text">PvT · 4 Gate Blink</p>
                <p className="text-micro text-text-dim">Step 4 of 9 · on pace</p>
              </div>
              <span className="font-mono text-h3 font-bold text-accent-cyan">4:19</span>
            </div>
            <ol className="mt-4 space-y-2">
              {GHOST_STEPS.map((step) => (
                <li key={step.time} className={`grid grid-cols-[2.8rem_1fr_auto] items-center gap-3 rounded-sm border px-3 py-2 ${step.state === "now" ? "border-accent-cyan/50 bg-accent-cyan/10" : "border-border bg-bg-surface"}`}>
                  <span className="font-mono text-micro text-text-dim">{step.time}</span>
                  <span className={`text-caption ${step.state === "now" ? "font-bold text-text" : "text-text-muted"}`}>{step.label}</span>
                  {step.state === "done" ? <CheckCircle2 className="h-4 w-4 text-success" aria-label="Complete" /> : step.state === "now" ? <Radio className="h-4 w-4 text-accent-cyan" aria-label="Current step" /> : <span className="text-micro text-text-dim">NEXT</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="bg-bg-elevated/25 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="kicker">Build Roulette · Act II</p>
              <h3 className="mt-2 font-serif text-[24px] font-semibold text-text">Now roll the opening units.</h3>
            </div>
            <Gamepad2 className="h-6 w-6 text-editorial" aria-hidden />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <UnitPick src="/icons/sc2/units/stalker.png" name="Stalker" odds="45%" />
            <UnitPick src="/icons/sc2/units/adept.png" name="Adept" odds="30%" />
          </div>
          <div className="mt-4 rounded-md border border-border bg-bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-caption font-bold text-text">Custom build rules</span>
              <span className="text-micro text-text-dim">BACKGROUND MATCHING</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-sm border border-success/30 bg-success/10 px-2 py-1 text-micro text-success">✓ Twilight by 3:50</span>
              <span className="rounded-sm border border-success/30 bg-success/10 px-2 py-1 text-micro text-success">✓ 4+ Gateways by 5:30</span>
              <span className="rounded-sm border border-danger/30 bg-danger/10 px-2 py-1 text-micro text-danger">× Stargate before 6:00</span>
            </div>
          </div>
          <p className="mt-4 text-caption text-text-muted">Save any replay as a build, publish it by name or anonymously, then let your full history reclassify safely in the background.</p>
        </div>
      </div>
      <figcaption className="border-t border-border px-5 py-3 text-caption text-text-muted">
        Illustrative Ghost Build, Build Roulette, and custom-rule preview with sample data.
      </figcaption>
    </figure>
  );
}

function UnitPick({ src, name, odds }: { src: string; name: string; odds: string }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-editorial/30 bg-editorial/10 p-3 text-center">
      <Sparkles className="absolute right-2 top-2 h-4 w-4 text-editorial" aria-hidden />
      <Image src={src} alt="" width={76} height={76} className="mx-auto h-16 w-16 object-contain drop-shadow-[0_4px_10px_rgba(0,0,0,.6)]" />
      <p className="mt-2 text-caption font-bold text-text">{name}</p>
      <p className="text-micro text-text-dim">{odds} roll weight</p>
    </div>
  );
}

const PLATFORM_COUNTS = [
  { label: "TWITCH", value: "184", color: "bg-[#9146ff]" },
  { label: "YOUTUBE", value: "62", color: "bg-[#ff2c2c]" },
  { label: "KICK", value: "21", color: "bg-[#53fc18]" },
  { label: "TIKTOK", value: "LIVE", color: "bg-[#25f4ee]" },
] as const;

const CHAT_LINES = [
  { platform: "TW", name: "ProxyPilot", body: "that hold was unreal", color: "text-[#b89cff]" },
  { platform: "YT", name: "MacroMode", body: "!rank", color: "text-[#ff8585]" },
  { platform: "BOT", name: "SC2 Tools", body: "Current MMR: 4,612 · Diamond 1", color: "text-accent-cyan" },
] as const;

export function StreamStudioPreview() {
  return (
    <figure className="overflow-hidden rounded-md border-2 border-line bg-[#080b10] shadow-hard">
      <div className="grid xl:grid-cols-[minmax(0,1.25fr)_22rem]">
        <div className="relative min-h-[430px] overflow-hidden border-b border-white/10 xl:border-b-0 xl:border-r">
          <Image
            src="/stream-backgrounds/1080p/04-interstellar-broadcast-studio.jpg"
            alt="Built-in interstellar broadcast studio virtual set"
            fill
            sizes="(min-width: 1280px) 60vw, 100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-black/35" />
          <div className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 bg-black/65 px-4 py-3 backdrop-blur-sm">
            {PLATFORM_COUNTS.map((platform) => (
              <span key={platform.label} className="inline-flex items-center gap-1.5 rounded-sm border border-white/10 bg-black/45 px-2 py-1 text-[9px] font-bold text-white">
                <span className={`h-1.5 w-1.5 rounded-full ${platform.color}`} />
                {platform.label} {platform.value}
              </span>
            ))}
            <span className="ml-auto text-caption font-bold text-white">267+ watching</span>
          </div>
          <div className="absolute left-1/2 top-[42%] w-full -translate-x-1/2 -translate-y-1/2 px-4 text-center">
            <p className="text-micro font-bold uppercase tracking-[.28em] text-white/65">SC2 Tools Studio</p>
            <p className="mt-2 font-display text-[34px] font-extrabold tracking-[.08em] text-white sm:text-[48px]">STARTING SOON</p>
            <p className="mt-1 font-mono text-[28px] font-bold text-accent-cyan sm:text-[36px]">04:59</p>
          </div>
          <div className="absolute bottom-4 left-4 right-4 rounded-md border border-white/15 bg-black/75 p-3 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-micro font-bold uppercase tracking-[.1em] text-accent-cyan">
              <Film className="h-4 w-4" aria-hidden /> Highlight reel · clip 3 of 14
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-[63%] rounded-full bg-accent-cyan" />
            </div>
          </div>
        </div>

        <div className="bg-[#0c1017] p-4 text-white sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-micro font-bold uppercase tracking-[.16em] text-[#3ce0d6]">Stream Dock</p>
              <p className="mt-1 text-caption font-bold">One place to run the show</p>
            </div>
            <span className="rounded-full bg-[#3ec884]/15 px-2 py-1 text-micro font-bold text-[#66e1a2]">LIVE</span>
          </div>

          <div className="mt-4 space-y-2 rounded-md border border-white/10 bg-white/[.03] p-3">
            {CHAT_LINES.map((line) => (
              <div key={`${line.name}-${line.body}`} className="text-[11px] leading-5 text-white/75">
                <span className="mr-1 rounded-sm bg-white/10 px-1 py-0.5 text-[8px] font-bold text-white/65">{line.platform}</span>
                <span className={`font-bold ${line.color}`}>{line.name}</span>{" "}{line.body}
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-md border border-[#f5b84a]/35 bg-[#f5b84a]/10 p-3">
            <div className="flex items-center gap-2">
              <BellRing className="h-4 w-4 text-[#f5b84a]" aria-hidden />
              <span className="text-micro font-bold uppercase tracking-[.12em] text-[#f5b84a]">Incoming raid</span>
              <span className="ml-auto text-caption font-bold">250 viewers</span>
            </div>
            <p className="mt-1 text-caption text-white/80">Alert queued once · timeline synced</p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <DockAction icon={Video} label="Scene" value="Starting Soon" />
            <DockAction icon={Film} label="B-roll" value="Playing" />
            <DockAction icon={Sparkles} label="Highlight" value="Mark clip" />
            <DockAction icon={Users} label="Poll" value="Open vote" />
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-[9px] font-semibold text-white/55">
            <span className="rounded-sm border border-white/10 px-2 py-1">AUTO SCENE SWITCHING</span>
            <span className="rounded-sm border border-white/10 px-2 py-1">OFFICIAL EVENTS</span>
            <span className="rounded-sm border border-white/10 px-2 py-1">SYNCED B-ROLL</span>
          </div>
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-black/80 px-4 py-3 text-caption text-white/60">
        <span>Illustrative Stream Dock preview with sample data.</span>
        <span>{PRODUCT_FACTS.virtualSets} virtual sets · {PRODUCT_FACTS.overlayWidgets} OBS widgets · {PRODUCT_FACTS.chatPlatforms} chat platforms</span>
      </figcaption>
    </figure>
  );
}

function DockAction({ icon: Icon, label, value }: { icon: typeof Video; label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[.04] p-2.5">
      <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[.1em] text-white/45">
        <Icon className="h-3.5 w-3.5 text-[#3ce0d6]" aria-hidden /> {label}
      </div>
      <p className="mt-1 text-[11px] font-semibold text-white/85">{value}</p>
    </div>
  );
}

const SETS = [
  { src: "/stream-backgrounds/1080p/02-renegade-battlecruiser-bridge.jpg", label: "Battlecruiser bridge" },
  { src: "/stream-backgrounds/1080p/04-interstellar-broadcast-studio.jpg", label: "Broadcast studio" },
  { src: "/stream-backgrounds/1080p/06-ancient-carrier-sanctuary.jpg", label: "Carrier sanctuary" },
] as const;

export function VirtualSetStrip() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {SETS.map((set) => (
        <figure key={set.src} className="overflow-hidden rounded-md border border-border bg-bg-surface">
          <div className="relative aspect-video overflow-hidden">
            <Image src={set.src} alt={`${set.label} built-in virtual set`} fill sizes="(min-width: 640px) 33vw, 100vw" className="object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:hover:scale-[1.02]" />
          </div>
          <figcaption className="flex items-center gap-2 px-3 py-2 text-micro text-text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden /> Built in · {set.label}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
