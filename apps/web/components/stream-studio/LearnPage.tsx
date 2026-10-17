import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Compass, Layers3, Wrench } from "lucide-react";
import { CrashCourse } from "./CrashCourse";
import { WidgetExplorer } from "./WidgetExplorer";
import { LearnTroubleshooting } from "./LearnTroubleshooting";

const STARTERS = [
  { name: "Your first stream", goal: "A clean scoreboard and context for every game.", widgets: [
    { id: "session", name: "Session record", why: "Keep the day's story on screen." },
    { id: "opponent", name: "Opponent identity", why: "Introduce who you're facing." },
    { id: "match-result", name: "Match result", why: "Let viewers catch the outcome." },
  ] },
  { name: "A practice night", goal: "Make the plan visible, then put it into practice.", widgets: [
    { id: "ghost-build", name: "Ghost Build coach", why: "Follow the next steps of your chosen build." },
    { id: "randomizer", name: "Build randomizer", why: "Choose an opening from your own pool." },
    { id: "scouting", name: "Scouting tells", why: "Learn what to watch for from the opponent." },
  ] },
  { name: "A community night", goal: "Bring the conversation into the broadcast.", widgets: [
    { id: "multichat", name: "Multi-platform chat", why: "Show the conversation in one place." },
    { id: "chat-highlight", name: "Chat highlight", why: "Put a great question on screen." },
    { id: "chat-poll", name: "Chat poll", why: "Give viewers a decision to make." },
  ] },
] as const;

export function LearnPage() {
  return (
    <article className="mx-auto max-w-6xl pb-8">
      <Link href="/stream-studio" className="inline-flex min-h-11 items-center gap-2 text-caption font-semibold text-text-muted hover:text-accent"><ArrowLeft className="h-4 w-4" aria-hidden />Stream Studio</Link>
      <header className="grid gap-8 pb-9 pt-4 lg:grid-cols-[1.2fr_0.8fr] lg:items-center md:pb-12 md:pt-8">
        <div>
          <p className="kicker">Stream Studio · learn by doing</p>
          <h1 className="mt-4 font-serif text-[38px] font-semibold leading-[1.08] tracking-tight text-text sm:text-5xl md:text-[56px]">Your first overlay.<br />Then your whole stream.</h1>
          <p className="mt-5 max-w-xl text-body-lg text-text-muted">Never added a widget before? You&apos;re in the right place. Build one working scene, learn what each widget means, and add the pieces that suit your stream.</p>
          <a href="#crash-course" className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-full border-2 border-line bg-accent px-6 py-3 font-display text-body font-bold text-white shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg">Start the crash course<ArrowDown className="h-4 w-4" aria-hidden /></a>
          <p className="mt-4 text-caption text-text-dim">Five short lessons · follow at your own pace · no account needed to learn</p>
        </div>
        <div className="rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-7">
          <span className="inline-flex rounded-full bg-editorial/10 px-3 py-1 text-micro font-semibold uppercase tracking-wider text-editorial">The first-stream recipe</span>
          <h2 className="mt-4 font-display text-h3 font-bold text-text">Three widgets. One clear story.</h2>
          <ol className="mt-5 space-y-4">
            {[{ name: "Who am I facing?", widget: "Opponent identity", id: "opponent" }, { name: "How did that go?", widget: "Match result", id: "match-result" }, { name: "How's the session going?", widget: "Session record", id: "session" }].map((item, index) => (
              <li key={item.id} className="flex items-start gap-3">
                <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border border-border bg-bg-elevated font-mono text-caption text-accent" aria-hidden>{index + 1}</span>
                <div className="min-w-0"><p className="text-body font-semibold text-text">{item.name}</p><a href={`/stream-studio/learn?widget=${item.id}#widget-library`} className="inline-flex min-h-11 items-center gap-1 text-caption text-text-muted underline underline-offset-4 hover:text-accent">{item.widget}<ArrowRight className="h-3 w-3" aria-hidden /></a></div>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-border pt-4 text-caption text-text-dim">Start with the All-in-one source and enable just these three. You can grow the scene later.</p>
        </div>
      </header>

      <nav aria-label="Learning sections" className="sticky top-16 z-20 flex flex-wrap gap-2 rounded-md border-2 border-line bg-bg px-3 py-2 shadow-sm sm:gap-3">
        {[{ href: "#crash-course", label: "Crash course", icon: BookOpen }, { href: "#starter-setups", label: "Starter setups", icon: Layers3 }, { href: "#widget-library", label: "Widget guide", icon: Compass }, { href: "#troubleshooting", label: "Fix a problem", icon: Wrench }].map(({ href, label, icon: Icon }) => (
          <a key={href} href={href} className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-caption font-semibold text-text-muted hover:bg-bg-elevated hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><Icon className="h-4 w-4" aria-hidden />{label}</a>
        ))}
      </nav>

      <CrashCourse />

      <section id="starter-setups" aria-labelledby="starter-setups-title" className="scroll-mt-28 pt-16 md:pt-24">
        <p className="kicker">Pick a starting point</p>
        <h2 id="starter-setups-title" className="mt-3 font-serif text-3xl font-semibold text-text md:text-4xl">A small setup you can make your own.</h2>
        <p className="mt-4 max-w-2xl text-body-lg text-text-muted">These are suggested combinations, not automatic presets. Open any widget&apos;s guide, then enable and test it in Settings.</p>
        <div className="mt-7 grid gap-5 lg:grid-cols-3">
          {STARTERS.map((starter) => (
            <article key={starter.name} className="flex min-w-0 flex-col rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-6">
              <CheckCircle2 className="h-6 w-6 text-accent" aria-hidden />
              <h3 className="mt-4 font-display text-h3 font-bold text-text">{starter.name}</h3>
              <p className="mt-2 text-body text-text-muted">{starter.goal}</p>
              <ul className="mt-5 space-y-4 border-t border-border pt-5">
                {starter.widgets.map((widget) => <li key={widget.id}><a href={`/stream-studio/learn?widget=${widget.id}#widget-library`} className="inline-flex min-h-11 items-center gap-2 text-body font-semibold text-accent underline-offset-4 hover:underline">{widget.name}<ArrowRight className="h-4 w-4" aria-hidden /></a><p className="text-caption text-text-muted">{widget.why}</p></li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <WidgetExplorer />
      <LearnTroubleshooting />
      <section className="mt-16 flex flex-col gap-5 rounded-md border-2 border-line bg-accent/5 p-6 sm:p-8 md:flex-row md:items-center md:justify-between">
        <div><h2 className="font-display text-h2 font-bold text-text">Make your first source work.</h2><p className="mt-2 text-body text-text-muted">Then come back here for the next piece. Your course progress stays in this browser.</p></div>
        <Link href="/settings?tab=overlay" className="inline-flex min-h-12 flex-none items-center justify-center gap-2 rounded-full border-2 border-line bg-accent px-5 py-3 font-display font-bold text-white shadow-hard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg">Go to Overlay settings<ArrowRight className="h-4 w-4" aria-hidden /></Link>
      </section>
    </article>
  );
}
