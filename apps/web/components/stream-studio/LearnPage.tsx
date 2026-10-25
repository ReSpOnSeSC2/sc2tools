import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowRight, CheckCircle2, Layers3 } from "lucide-react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { LearnSectionNav } from "./LearnSectionNav";
import { CrashCourse } from "./CrashCourse";
import { WidgetExplorer } from "./WidgetExplorer";
import { LearnTroubleshooting } from "./LearnTroubleshooting";

import { OVERLAY_STARTER_PACKS as STARTERS } from '@/lib/overlayStarterPacks';

export function LearnPage() {
  return (
    <article className="mx-auto max-w-6xl pb-8">
      <Link href="/stream-studio" className="inline-flex min-h-11 items-center gap-2 text-caption font-semibold text-text-muted hover:text-accent"><ArrowLeft className="h-4 w-4" aria-hidden />Stream Studio</Link>
      <header className="grid gap-8 pb-9 pt-4 lg:grid-cols-[1.2fr_0.8fr] lg:items-center md:pb-12 md:pt-8">
        <div>
          <p className="kicker">Stream Studio · learn by doing</p>
          <h1 className="mt-4 font-serif text-[38px] font-semibold leading-[1.08] tracking-tight text-text sm:text-5xl md:text-[56px]">Your first overlay.<br />Then your whole stream.</h1>
          <p className="mt-5 max-w-xl text-body-lg text-text-muted">Never added a widget before? You&apos;re in the right place. Build one working scene, learn what each widget means, and add the pieces that suit your stream.</p>
          <a href="#crash-course" className={buttonClassName({ size: "lg", className: "mt-6" })}>Start the crash course<ArrowDown className="h-4 w-4" aria-hidden /></a>
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

      <LearnSectionNav />

      <CrashCourse />

      <section id="starter-setups" aria-labelledby="starter-setups-title" className="scroll-mt-28 pt-16 md:pt-24">
        <p className="kicker">Pick a starting point</p>
        <h2 id="starter-setups-title" className="mt-3 font-serif text-3xl font-semibold text-text md:text-4xl">A small setup you can make your own.</h2>
        <p className="mt-4 max-w-2xl text-body-lg text-text-muted">Choose a starter pack, review exactly what it enables in Settings, then add and test its Browser Sources.</p>
        <div className="mt-7 grid gap-5 lg:grid-cols-3">
          {STARTERS.map((starter) => (
            <article key={starter.name} className="flex min-w-0 flex-col rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-6">
              <CheckCircle2 className="h-6 w-6 text-accent" aria-hidden />
              <h3 className="mt-4 font-display text-h3 font-bold text-text">{starter.name}</h3>
              <p className="mt-2 text-body text-text-muted">{starter.goal}</p>
              <ul className="mt-5 space-y-4 border-t border-border pt-5">
                {starter.widgets.map((widget) => <li key={widget.id}><a href={`/stream-studio/learn?widget=${widget.id}#widget-library`} className="inline-flex min-h-11 items-center gap-2 text-body font-semibold text-accent underline-offset-4 hover:underline">{widget.name}<ArrowRight className="h-4 w-4" aria-hidden /></a><p className="text-caption text-text-muted">{widget.why}</p></li>)}
              </ul>
              <Link href={`/settings?tab=overlay&section=widgets&pack=${starter.id}`} className={buttonClassName({ className: "mt-5" })}>Enable this setup<ArrowRight className="h-4 w-4" aria-hidden /></Link>
            </article>
          ))}
        </div>
      </section>

      <WidgetExplorer />
      <LearnTroubleshooting />
      <section className="mt-16 flex flex-col gap-5 rounded-md border-2 border-line bg-accent/5 p-6 sm:p-8 md:flex-row md:items-center md:justify-between">
        <div><h2 className="font-display text-h2 font-bold text-text">Make your first source work.</h2><p className="mt-2 text-body text-text-muted">Then come back here for the next piece. Your course progress stays in this browser.</p></div>
        <Link href="/settings?tab=overlay" className={buttonClassName({ size: "lg", className: "flex-none" })}>Go to Overlay settings<ArrowRight className="h-4 w-4" aria-hidden /></Link>
      </section>
    </article>
  );
}
