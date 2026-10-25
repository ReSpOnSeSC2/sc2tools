"use client";

/**
 * ChatCommandsCard — what viewers can type in chat, with a one-tap
 * "Copy for your bio" export. Rendered in Settings → Overlay →
 * Multi-platform chat AND in the Help tab; both feed off the same
 * commandsGuide data, and the copied text follows the streamer's
 * chosen loyalty rank race.
 */

import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { Check, ClipboardCopy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { commandGroups, buildBioText } from "@/lib/multichat/commandsGuide";
import { boundedApiRequest } from "@/lib/clientApi";
import type { ChatCommandPreferences } from "@/lib/multichat/chatCommandPreferences";
import type { RankRace } from "@/lib/multichat/rankLadders";

type Props = { rankRace: RankRace; editable?: boolean; token?: string | null };
export function ChatCommandsCard(props: Props) {
  return props.editable ? <OwnedCommandGuide {...props} /> : <CommandGuide rankRace={props.rankRace} />;
}

function OwnedCommandGuide(props: Props) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p role="status" className="text-caption text-text-muted">Loading command settings…</p>;
  if (!isSignedIn || !userId) return <CommandGuide rankRace={props.rankRace} />;
  return <CommandGuide key={`${userId}:${props.token || ""}`} {...props} />;
}

function CommandGuide({ rankRace, editable = false, token }: Props) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<ChatCommandPreferences | null>(null);
  const [fallback, setFallback] = useState("");
  const copyField = useRef<HTMLTextAreaElement>(null), mounted = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (fallback) { copyField.current?.focus(); copyField.current?.select(); } }, [fallback]);

  const copyBio = async () => {
    try {
      const text = buildBioText(rankRace, saved ?? undefined);
      await boundedApiRequest(() => navigator.clipboard.writeText(text), 10_000);
      if (!mounted.current) return;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
      toast.success("Copied", {
        description: "Paste it into your Twitch/Kick/YouTube/TikTok bio or panels.",
      });
    } catch {
      if (mounted.current) setFallback(buildBioText(rankRace, saved ?? undefined));
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-body font-medium text-text">
          Chat commands your viewers can use
        </div>
        <Button size="sm" className="min-h-11" variant="secondary" disabled={editable && !saved} onClick={() => void copyBio()}>
          {copied ? (
            <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
          ) : (
            <ClipboardCopy className="mr-1 h-3.5 w-3.5" aria-hidden />
          )}
          {copied ? "Copied" : "Copy for your bio"}
        </Button>
      </div>
      <p className="text-caption text-text-dim">
        {editable ? "Availability follows your saved platform and on-stream settings. The copied bio uses your saved commands and selected loyalty rank theme." : "This is the default command guide. Streamers can change aliases, cooldowns and availability in Settings. The overlay can answer on stream without a separate bot."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {commandGroups(saved ?? undefined).map((g) => (
          <div key={g.id} className="min-w-0 rounded-md border border-border p-2.5">
            <div className="text-caption font-semibold text-text">
              {g.emoji} {g.title}
            </div>
            <p className="mt-1 text-micro leading-relaxed text-text-dim">
              {g.intro}
            </p>
            <ul className="mt-1.5 space-y-1">
              {g.commands.map((c) => (
                <li key={c.syntax} className="flex min-w-0 items-baseline gap-2">
                  <code className="shrink-0 rounded bg-bg-surface px-1.5 py-0.5 text-micro font-semibold text-accent-cyan">
                    {c.syntax}
                  </code>
                  <span className="min-w-0 text-micro text-text-muted">
                    {c.description}
                    {c.aliases ? (
                      <span className="text-text-dim"> · also {c.aliases}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {fallback ? <label className="block text-caption text-text-muted">Copy this bio text<textarea ref={copyField} readOnly value={fallback} onFocus={event => event.currentTarget.select()} className="mt-1 min-h-24 w-full rounded-lg border border-border bg-bg-surface p-2 text-caption" /></label> : null}
      {editable ? token ? <LazyEditor token={token} onSaved={setSaved} /> : <p className="text-caption text-text-muted">Choose an overlay token to edit and preview saved commands.</p> : null}
    </div>
  );
}

const makeEditor = () => lazy(() => boundedApiRequest(() => import("./ChatCommandsEditor").then(module => ({ default: module.ChatCommandsEditor })), 15_000));
function LazyEditor({ token, onSaved }: { token: string; onSaved: (preferences: ChatCommandPreferences | null) => void }) {
  const [attempt, retry] = useState(0), [Editor, setEditor] = useState(makeEditor);
  return <EditorBoundary key={attempt} retry={() => { setEditor(makeEditor); retry(value => value + 1); }}><Suspense fallback={<p role="status" className="text-caption text-text-muted">Loading command editor…</p>}><Editor token={token} onSaved={onSaved} /></Suspense></EditorBoundary>;
}
class EditorBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="space-y-2 text-caption text-text-muted"><p>Couldn’t load the command editor. The guide remains available.</p><Button className="min-h-11" variant="secondary" onClick={this.props.retry}>Retry command editor</Button></div> : this.props.children; }
}
