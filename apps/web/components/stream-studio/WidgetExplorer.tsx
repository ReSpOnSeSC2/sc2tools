"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Copy, Expand, Layers3, Search, SlidersHorizontal } from "lucide-react";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { buttonClassName } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { WIDGET_GROUPS, WIDGET_GUIDES, type WidgetGuide } from "@/lib/streamStudioLearn";
import { LazyWidgetPlayground } from "./LazyWidgetPlayground";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/** Public learning examples only. Never opens an overlay socket or needs a token. */
export function WidgetExplorer() {
  const [query, setQuery] = useState("");
  const [galleryOpen, setGalleryOpen] = useState(false);
  useEffect(() => { setGalleryOpen(window.matchMedia?.("(min-width: 768px)").matches ?? false); }, []);
  const [group, setGroup] = useState<WidgetGuide["group"] | "all">("all");
  const [activeId, setActiveId] = useState("opponent");
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const focusRelated = useRef(false);

  useEffect(() => {
    const readLocation = () => {
      const requested = new URL(window.location.href).searchParams.get("widget");
      if (WIDGET_GUIDES.some((guide) => guide.id === requested)) {
        setActiveId(requested!);
        setGroup("all");
        setQuery("");
      }
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return WIDGET_GUIDES.filter((guide) =>
      (group === "all" || guide.group === group) &&
      (!term || [guide.name, guide.summary, guide.explanation, ...guide.needs]
        .join(" ").toLowerCase().includes(term)),
    );
  }, [query, group]);
  const selected = filtered.find((guide) => guide.id === activeId) ?? filtered[0];

  useEffect(() => {
    setCopied(false);
    setManualLink(null);
    if (!focusRelated.current || !selected) return;
    focusRelated.current = false;
    detailRef.current?.focus({ preventScroll: true });
    detailRef.current?.scrollIntoView?.({ block: "start" });
  }, [selected]);

  function choose(id: string) {
    setActiveId(id);
    setCopied(false);
    setManualLink(null);
    const url = new URL(window.location.href);
    url.searchParams.set("widget", id);
    url.hash = "widget-library";
    window.history.replaceState(null, "", url);
  }

  async function copyGuide() {
    if (!selected) return;
    const url = new URL("/stream-studio/learn", window.location.origin);
    url.searchParams.set("widget", selected.id);
    url.hash = "widget-library";
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setManualLink(null);
    } catch {
      setCopied(false);
      setManualLink(url.toString());
    }
  }

  return (
    <section id="widget-library" aria-labelledby="widget-library-title" className="scroll-mt-28 pt-16 md:pt-24">
      <p className="kicker">The field guide</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="widget-library-title" className="font-serif text-3xl font-semibold text-text md:text-4xl">Find your widget. Know exactly what to do.</h2>
          <p className="mt-4 text-body-lg text-text-muted">What it shows, what makes it appear, and how to get it into your scene. Start with one; add more when you need them.</p>
        </div>
        <span className="rounded-full border border-border bg-bg-surface px-3 py-1 text-caption font-semibold text-text-muted">{WIDGET_GUIDES.length} widgets explained</span>
      </div>

      <div className="mt-7 rounded-md border-2 border-line bg-bg-surface p-4 sm:p-5">
        <label htmlFor="widget-search" className="text-caption font-semibold text-text">Search the widget guide</label>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-text-dim" aria-hidden />
          <input id="widget-search" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setCopied(false); }}
            placeholder="Try scouting, MMR, chat, or countdown…"
            className={`min-h-12 w-full rounded-md border border-border bg-bg py-3 pl-10 pr-3 text-body text-text placeholder:text-text-dim ${FOCUS}`} />
        </div>
        <div className="mt-4 sm:hidden">
          <label htmlFor="widget-category" className="text-caption font-semibold text-text">Category</label>
          <select id="widget-category" value={group} onChange={(event) => { setGroup(event.target.value as WidgetGuide["group"] | "all"); setCopied(false); setManualLink(null); }} className={`mt-2 min-h-11 w-full rounded-md border border-border bg-bg px-3 py-2 text-body text-text ${FOCUS}`}>
            <option value="all">All widgets</option>
            {WIDGET_GROUPS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div aria-label="Widget categories" className="mt-4 hidden flex-wrap gap-2 sm:flex">
          {[{ id: "all" as const, name: "All widgets" }, ...WIDGET_GROUPS].map((item) => (
            <button key={item.id} type="button" aria-pressed={group === item.id}
              onClick={() => { setGroup(item.id); setCopied(false); }}
              className={`min-h-11 rounded-full border px-4 py-2 text-caption font-semibold ${FOCUS} ${group === item.id ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:bg-bg-elevated"}`}>
              {item.name}
            </button>
          ))}
        </div>
        <p role="status" className="mt-3 text-caption text-text-dim">{filtered.length} {filtered.length === 1 ? "widget" : "widgets"} found{group !== "all" ? ` · ${WIDGET_GROUPS.find((item) => item.id === group)?.description}` : ""}</p>
      </div>

      {filtered.length > 0 ? (
        <details open={galleryOpen} onToggle={(event) => setGalleryOpen(event.currentTarget.open)} className="mt-4 rounded-md border-2 border-line bg-bg-surface">
          <summary className={`min-h-12 cursor-pointer rounded-md px-4 py-3 text-body font-semibold text-text ${FOCUS}`}>
            Browse widget previews <span className="text-caption font-normal text-text-dim">({filtered.length})</span>
          </summary>
          <ul aria-label="Widget preview gallery" className="grid grid-cols-2 gap-3 border-t border-border p-4 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((guide) => (
              <li key={guide.id} className="min-w-0">
                <button type="button" aria-pressed={selected?.id === guide.id}
                  onClick={() => {
                    focusRelated.current = true;
                    choose(guide.id);
                    if (selected?.id === guide.id) {
                      focusRelated.current = false;
                      detailRef.current?.focus({ preventScroll: true });
                      detailRef.current?.scrollIntoView?.({ block: "start" });
                    }
                  }}
                  className={`h-full w-full overflow-hidden rounded-md border-2 text-left ${FOCUS} ${selected?.id === guide.id ? "border-accent bg-accent/10 text-accent" : "border-border text-text hover:border-accent"}`}>
                  <Image src={`/images/widget-examples/${guide.id}.webp`} alt="" width={1400} height={900} sizes="(min-width: 1024px) 260px, (min-width: 640px) 30vw, 45vw" className="block h-auto w-full" />
                  <span className="flex min-h-12 items-center px-3 py-2 text-caption font-semibold">{guide.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {selected ? (
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
          <nav aria-label="Choose a widget" className="hidden max-h-[calc(100vh-11rem)] space-y-1 overflow-y-auto rounded-md border-2 border-line bg-bg-surface p-2 lg:sticky lg:top-36 lg:block">
            {filtered.map((guide) => (
              <button key={guide.id} type="button" aria-pressed={selected.id === guide.id} onClick={() => choose(guide.id)}
                className={`flex min-h-12 w-full items-center justify-between gap-2 rounded px-3 py-3 text-left text-body ${FOCUS} ${selected.id === guide.id ? "bg-accent/10 font-semibold text-accent" : "text-text-muted hover:bg-bg-elevated"}`}>
                {guide.name}<ArrowRight className="h-4 w-4 flex-none" aria-hidden />
              </button>
            ))}
          </nav>
          <div className="min-w-0 space-y-4">
            <div className="lg:hidden">
              <label htmlFor="widget-picker" className="text-caption font-semibold text-text">Choose a widget</label>
              <select id="widget-picker" value={selected.id} onChange={(event) => choose(event.target.value)}
                className={`mt-2 min-h-12 w-full rounded-md border-2 border-line bg-bg-surface px-3 py-2 text-body text-text ${FOCUS}`}>
                {filtered.map((guide) => <option key={guide.id} value={guide.id}>{guide.name}</option>)}
              </select>
            </div>
            <WidgetDetail guide={selected} detailRef={detailRef} onRelated={(id) => { focusRelated.current = true; setQuery(""); setGroup("all"); choose(id); }} />
            <button type="button" onClick={copyGuide} className={`inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-caption font-semibold text-text-muted hover:text-accent ${FOCUS}`}>
              <Copy className="h-4 w-4" aria-hidden />{copied ? "Guide link copied" : "Copy a link to this guide"}
            </button>
            {manualLink ? <label className="block text-caption text-text-muted">Copy this public guide link manually<input readOnly value={manualLink} onFocus={(event) => event.target.select()} className={`mt-2 min-h-11 w-full min-w-0 rounded border border-border bg-bg-surface px-3 text-body text-text ${FOCUS}`} /></label> : null}
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-md border-2 border-line bg-bg-surface px-6 py-10 text-center">
          <p className="font-display text-h3 font-bold text-text">No widgets match that search.</p>
          <p className="mt-2 text-body text-text-muted">Try a shorter name or look across all categories.</p>
          <button type="button" onClick={() => { setQuery(""); setGroup("all"); }} className={`mt-4 min-h-11 rounded-full border-2 border-line px-5 font-semibold text-text ${FOCUS}`}>Clear search and filters</button>
        </div>
      )}
    </section>
  );
}

function WidgetDetail({ guide, onRelated, detailRef }: { guide: WidgetGuide; onRelated: (id: string) => void; detailRef: RefObject<HTMLElement | null> }) {
  return (
    <article ref={detailRef} tabIndex={-1} aria-label={`${guide.name} guide`} className="min-w-0 scroll-mt-28 overflow-hidden rounded-md border-2 border-line bg-bg-surface shadow-hard focus:outline-none">
      <header className="border-b border-border p-5 sm:p-7">
        <p className="text-caption font-semibold text-accent">{WIDGET_GROUPS.find((group) => group.id === guide.group)?.name}</p>
        <h3 className="mt-2 font-display text-3xl font-bold text-text">{guide.name}</h3>
        <p className="mt-3 text-body-lg text-text-muted">{guide.summary}</p>
        <span className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-3 py-1.5 text-caption font-semibold text-text-muted">
          <Layers3 className="h-4 w-4" aria-hidden />{guide.source === "all-in-one" ? "All-in-one or its own Browser Source" : "Use its own Browser Source"}
        </span>
      </header>
      <div className="space-y-7 p-5 sm:p-7">
        <WidgetExample key={guide.id} guide={guide} />
        <div>
          <h4 className="font-display text-h4 font-bold text-text">What you&apos;re looking at</h4>
          <p className="mt-2 text-body text-text-muted">{guide.explanation}</p>
          {guide.helpSlug ? (
            <LazyHelpLink slug={guide.helpSlug} className="mt-2 inline-flex min-h-11 items-center text-body">
              Where these numbers come from
            </LazyHelpLink>
          ) : null}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-bg-elevated/50 p-4">
            <h4 className="text-body font-semibold text-text">When it appears</h4>
            <p className="mt-2 text-body text-text-muted">{guide.appears}</p>
          </div>
          <div className="rounded-md border border-border bg-bg-elevated/50 p-4">
            <h4 className="text-body font-semibold text-text">Have these ready</h4>
            <ul className="mt-2 space-y-2 text-body text-text-muted">
              {guide.needs.map((need) => <li key={need} className="flex items-start gap-2"><CheckCircle2 className="mt-1 h-4 w-4 flex-none text-accent" aria-hidden /><span>{need}</span></li>)}
            </ul>
          </div>
        </div>
        <div>
          <h4 className="flex items-center gap-2 font-display text-h4 font-bold text-text"><SlidersHorizontal className="h-5 w-5 text-accent" aria-hidden />Set it up</h4>
          <ol className="mt-4 space-y-3">
            {guide.setup.map((step, index) => (
              <li key={step} className="flex items-start gap-3 text-body text-text-muted"><span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-accent/10 text-caption font-bold text-accent" aria-hidden>{index + 1}</span><span>{step}</span></li>
            ))}
          </ol>
          <Link href={guide.settingsHref} className={buttonClassName({ className: "mt-5" })}>Open the right settings<ArrowRight className="h-4 w-4" aria-hidden /></Link>
        </div>
        <div className="border-l-4 border-accent bg-accent/5 p-4">
          <h4 className="text-body font-semibold text-text">Your first successful test</h4>
          <p className="mt-2 text-body text-text-muted">{guide.check}</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div><h4 className="text-body font-semibold text-text">Give it room</h4><p className="mt-2 text-body text-text-muted">{guide.placement}</p></div>
          <div><h4 className="text-body font-semibold text-text">If nothing appears</h4><p className="mt-2 text-body text-text-muted">{guide.troubleshooting}</p></div>
        </div>
        {guide.related.length > 0 ? (
          <div className="border-t border-border pt-5">
            <h4 className="text-caption font-semibold uppercase tracking-wider text-text-dim">Pairs well with</h4>
            <div className="mt-3 flex flex-wrap gap-2">
              {guide.related.map((id) => <button key={id} type="button" onClick={() => onRelated(id)} className={`min-h-11 rounded-full border border-border px-4 py-2 text-caption font-semibold text-text hover:border-accent hover:text-accent ${FOCUS}`}>{WIDGET_GUIDES.find((other) => other.id === id)?.name}</button>)}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function WidgetExample({ guide }: { guide: WidgetGuide }) {
  const [expanded, setExpanded] = useState(false);
  const src = `/images/widget-examples/${guide.id}.webp`;

  return (
    <>
      <figure className="overflow-hidden rounded-md border border-border bg-bg-elevated">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2">
          <span className="text-micro font-semibold uppercase tracking-wider text-text-dim">Example preview · sample data</span>
          <button type="button" onClick={() => setExpanded(true)} className={`inline-flex min-h-11 items-center gap-2 rounded-sm text-caption font-semibold text-accent hover:underline ${FOCUS}`}>
            <Expand className="h-4 w-4" aria-hidden />
            Enlarge preview
          </button>
        </div>
        <LazyWidgetPlayground initialWidget={guide.id} compact fallbackAlt={`${guide.name} widget preview with sample data`} />
        <figcaption className="border-t border-border px-4 py-3 text-caption text-text-muted">Local widget sample. Try a theme or scenario here; nothing is sent to OBS. Your real data may change its appearance.</figcaption>
      </figure>
      <Modal open={expanded} onClose={() => setExpanded(false)} title={`${guide.name} preview`} description="Example preview · sample data. Your theme and available data may change its appearance." size="3xl" mobileLayout="center"
        footer={<a href={src} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-4 py-2 text-caption font-semibold text-accent hover:bg-accent/10 ${FOCUS}`}><Expand className="h-4 w-4" aria-hidden />Open full-size image</a>}>
        {expanded ? <LazyWidgetPlayground initialWidget={guide.id} compact autoLoad fallbackAlt={`${guide.name} widget preview with sample data`} /> : null}
      </Modal>
    </>
  );
}
