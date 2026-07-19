"use client";

/**
 * Settings · Overlay · Multi-platform chat.
 *
 * Configures the `multichat` overlay widget — Twitch, Kick, YouTube
 * and TikTok live chat combined into one OBS Browser Source. Setup
 * cost per platform is deliberately minimal:
 *
 *   - Twitch:  channel name. Anonymous read-only IRC — no OAuth.
 *   - Kick:    channel name + a one-time chatroom-id detection. When
 *              Kick's bot protection blocks the automatic lookup, a
 *              guided manual flow takes over (open one URL in your own
 *              browser, paste what you see — we extract the id).
 *   - YouTube: channel handle/URL. The live stream is discovered
 *              automatically every stream — no video id juggling.
 *   - TikTok:  @username only. NO stream key required — chat reads
 *              from the public LIVE; while you're offline the widget
 *              simply idles and reconnects when you go live.
 *
 * Storage: /v1/me/preferences/multichat (whole-blob replace, same
 * pattern as every other preference type). The overlay widget re-reads
 * its config every minute, so saves land without touching OBS.
 */

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ExternalLink, Languages, LayoutPanelLeft, MessageSquare, Wand2 } from "lucide-react";
import { apiCall, useApi, API_BASE } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import {
  normalizeKickChannelInput,
  normalizeTikTokUsernameInput,
  normalizeTwitchChannel,
  parseKickChatroomInput,
} from "@/lib/multichat/config";
import {
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
  type ChatAppearance,
} from "@/lib/multichat/appearance";
import {
  DEFAULT_SOUND,
  sanitizeSoundConfig,
  type ChatSoundConfig,
} from "@/lib/multichat/sound";
import {
  DEFAULT_TTS,
  sanitizeTtsConfig,
  type ChatTtsConfig,
} from "@/lib/multichat/tts";
import type { MultichatConfig } from "@/lib/multichat/types";
import { UrlRow } from "./OverlayUrlRow";
import { SettingsMultiChatAppearance } from "./SettingsMultiChatAppearance";
import { SettingsMultiChatTts } from "./SettingsMultiChatTts";

/**
 * Inline chat-translation settings — stored under `translate` in the
 * SAME preferences blob. The endpoint + API key stay server-side: the
 * token-authed config route only ever ships {enabled, targetLang} to
 * OBS, and the widget sends message text to our own relay.
 */
type TranslateDraft = {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  targetLang: string;
};

const DEFAULT_TRANSLATE: TranslateDraft = {
  enabled: false,
  endpoint: "",
  apiKey: "",
  targetLang: "en",
};

type Draft = {
  twitchEnabled: boolean;
  twitchChannel: string;
  kickEnabled: boolean;
  kickChannel: string;
  kickChatroomId: number | null;
  youtubeEnabled: boolean;
  youtubeChannel: string;
  tiktokEnabled: boolean;
  tiktokUsername: string;
  appearance: ChatAppearance;
  tts: ChatTtsConfig;
  sound: ChatSoundConfig;
  translate: TranslateDraft;
};

const EMPTY_DRAFT: Draft = {
  twitchEnabled: false,
  twitchChannel: "",
  kickEnabled: false,
  kickChannel: "",
  kickChatroomId: null,
  youtubeEnabled: false,
  youtubeChannel: "",
  tiktokEnabled: false,
  tiktokUsername: "",
  appearance: DEFAULT_APPEARANCE,
  tts: DEFAULT_TTS,
  sound: DEFAULT_SOUND,
  translate: DEFAULT_TRANSLATE,
};

function draftFromConfig(config: MultichatConfig | undefined | null): Draft {
  return {
    twitchEnabled: config?.twitch?.enabled === true,
    twitchChannel: config?.twitch?.channel ?? "",
    kickEnabled: config?.kick?.enabled === true,
    kickChannel: config?.kick?.channel ?? "",
    kickChatroomId:
      typeof config?.kick?.chatroomId === "number"
        ? config.kick.chatroomId
        : null,
    youtubeEnabled: config?.youtube?.enabled === true,
    youtubeChannel: config?.youtube?.channel ?? "",
    tiktokEnabled: config?.tiktok?.enabled === true,
    tiktokUsername: config?.tiktok?.username ?? "",
    appearance: sanitizeAppearance(config?.appearance),
    tts: sanitizeTtsConfig(config?.tts),
    sound: sanitizeSoundConfig(config?.sound),
    translate: translateFromConfig(config),
  };
}

/** Defensive read of the untyped `translate` blob — inline defaults. */
function translateFromConfig(
  config: MultichatConfig | undefined | null,
): TranslateDraft {
  const t = (config as { translate?: Record<string, unknown> } | undefined | null)
    ?.translate;
  const d = DEFAULT_TRANSLATE;
  return {
    enabled: t?.enabled === true,
    endpoint: typeof t?.endpoint === "string" ? t.endpoint : d.endpoint,
    apiKey: typeof t?.apiKey === "string" ? t.apiKey : d.apiKey,
    targetLang:
      typeof t?.targetLang === "string" && t.targetLang.trim()
        ? t.targetLang.trim()
        : d.targetLang,
  };
}

function configFromDraft(
  d: Draft,
): MultichatConfig & { translate: Record<string, unknown> } {
  return {
    twitch: {
      enabled: d.twitchEnabled,
      channel: d.twitchChannel.trim() || undefined,
    },
    kick: {
      enabled: d.kickEnabled,
      channel: d.kickChannel.trim() || undefined,
      chatroomId: d.kickChatroomId ?? undefined,
    },
    youtube: {
      enabled: d.youtubeEnabled,
      channel: d.youtubeChannel.trim() || undefined,
    },
    tiktok: {
      enabled: d.tiktokEnabled,
      username: d.tiktokUsername.trim() || undefined,
    },
    appearance: d.appearance as unknown as Record<string, unknown>,
    tts: d.tts as unknown as Record<string, unknown>,
    sound: d.sound as unknown as Record<string, unknown>,
    translate: {
      enabled: d.translate.enabled,
      endpoint: d.translate.endpoint.trim(),
      apiKey: d.translate.apiKey.trim(),
      targetLang: d.translate.targetLang.trim().toLowerCase() || "en",
    },
  };
}

export function SettingsMultiChat({ token }: { token: string | null }) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useApi<MultichatConfig>(
    "/v1/me/preferences/multichat",
  );

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [kickManualOpen, setKickManualOpen] = useState(false);
  const [kickPaste, setKickPaste] = useState("");

  // window.origin is unavailable during SSR — resolve it post-mount so
  // the dock URL renders without a hydration mismatch.
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Hydrate the draft once per fetched config; user edits win after.
  useEffect(() => {
    if (!dirty && data) setDraft(draftFromConfig(data));
  }, [data, dirty]);

  const set = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    if (draft.twitchEnabled && !normalizeTwitchChannel(draft.twitchChannel)) {
      out.push("Twitch: enter your channel name (e.g. twitch.tv/yourname).");
    }
    if (draft.kickEnabled) {
      if (!normalizeKickChannelInput(draft.kickChannel)) {
        out.push("Kick: enter your channel name (e.g. kick.com/yourname).");
      } else if (!draft.kickChatroomId) {
        out.push("Kick: detect the chatroom id (button next to the field).");
      }
    }
    if (draft.youtubeEnabled && !draft.youtubeChannel.trim()) {
      out.push("YouTube: enter your handle or channel URL (e.g. @yourname).");
    }
    if (
      draft.tiktokEnabled &&
      !normalizeTikTokUsernameInput(draft.tiktokUsername)
    ) {
      out.push("TikTok: enter your @username.");
    }
    if (
      draft.translate.enabled &&
      !/^https:\/\//.test(draft.translate.endpoint.trim())
    ) {
      out.push("Translation: enter an https:// endpoint URL.");
    }
    return out;
  }, [draft]);

  const save = async () => {
    setSaving(true);
    try {
      const clean: Draft = {
        ...draft,
        twitchChannel: normalizeTwitchChannel(draft.twitchChannel) ?? draft.twitchChannel,
        kickChannel: normalizeKickChannelInput(draft.kickChannel) ?? draft.kickChannel,
        tiktokUsername:
          normalizeTikTokUsernameInput(draft.tiktokUsername) ?? draft.tiktokUsername,
      };
      const body = configFromDraft(clean);
      await apiCall(getToken, "/v1/me/preferences/multichat", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setDraft(clean);
      // Refetch BEFORE clearing dirty: the hydrate effect re-fills the
      // draft from SWR `data` the moment dirty flips false, and until
      // the refetch resolves that cache still holds the PRE-save blob —
      // clearing first briefly reverted the form and could silently
      // undo the save if the user kept editing in that window.
      await mutate();
      setDirty(false);
      toast.success("Chat settings saved", {
        description: "The overlay picks changes up within a minute.",
      });
    } catch {
      toast.error("Could not save chat settings");
    } finally {
      setSaving(false);
    }
  };

  const detectKick = async () => {
    const slug = normalizeKickChannelInput(draft.kickChannel);
    if (!slug || !token) return;
    setDetecting(true);
    try {
      const res = await fetch(
        `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/kick/resolve?slug=${encodeURIComponent(slug)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const body = (await res.json()) as { chatroomId: number };
        set({ kickChatroomId: body.chatroomId });
        setKickManualOpen(false);
        toast.success(`Kick chatroom detected (#${body.chatroomId})`, {
          description: "Don't forget to save.",
        });
        return;
      }
      const body = await res.json().catch(() => null);
      if (body?.error?.code === "not_found") {
        toast.error("Kick channel not found");
        return;
      }
      // kick_blocked (Cloudflare) → guided manual flow.
      setKickManualOpen(true);
    } catch {
      setKickManualOpen(true);
    } finally {
      setDetecting(false);
    }
  };

  const applyKickPaste = () => {
    const id = parseKickChatroomInput(kickPaste);
    if (!id) {
      toast.error("Couldn't find a chatroom id in that paste", {
        description: 'Paste the whole page, or just the number after "chatroom":{"id":',
      });
      return;
    }
    set({ kickChatroomId: id });
    setKickPaste("");
    setKickManualOpen(false);
    toast.success(`Kick chatroom set (#${id})`, {
      description: "Don't forget to save.",
    });
  };

  const kickSlug = normalizeKickChannelInput(draft.kickChannel);

  return (
    <Section
      title="Multi-platform chat"
      description="One OBS source that merges your Twitch, Kick, YouTube and TikTok chats into a single live feed. Enable the platforms you stream to, save, then add the Multi-platform chat widget URL above as a Browser Source."
    >
      <Card>
        {isLoading ? (
          <div className="text-caption text-text-muted">Loading chat settings…</div>
        ) : error && !data ? (
          // Never render an empty editable form over a failed load — a
          // "fix and save" from that state would wipe the stored config.
          <div className="space-y-2">
            <div className="text-caption text-danger">
              Couldn't load your chat settings ({error.message}).
            </div>
            <Button size="sm" variant="secondary" onClick={() => void mutate()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {token ? (
              <div className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-3">
                <div className="flex items-center gap-2 text-body font-medium text-text">
                  <LayoutPanelLeft className="h-4 w-4 text-accent-cyan" aria-hidden />
                  Stream Dock
                </div>
                <p className="text-caption text-text-dim">
                  Your second-screen control panel for this chat: pin
                  highlights, run polls, track goals and block spammers
                  mid-stream. In OBS, add it via{" "}
                  <b>Docks → Custom Browser Docks</b> — or open it on a
                  phone or second monitor.
                </p>
                {origin ? <UrlRow url={`${origin}/dock/${token}`} compact /> : null}
              </div>
            ) : null}

            <PlatformRow
              label="Twitch"
              enabled={draft.twitchEnabled}
              onToggle={(on) => set({ twitchEnabled: on })}
              hint="Read-only chat via Twitch's anonymous IRC — no Twitch login or OAuth needed."
            >
              <TextInput
                value={draft.twitchChannel}
                onChange={(v) => set({ twitchChannel: v })}
                placeholder="your channel — e.g. twitch.tv/yourname or yourname"
                disabled={!draft.twitchEnabled}
              />
            </PlatformRow>

            <PlatformRow
              label="Kick"
              enabled={draft.kickEnabled}
              onToggle={(on) => set({ kickEnabled: on })}
              hint="Reads your public Kick chatroom directly — one-time chatroom-id detection, then no server involved."
              badge={
                draft.kickChatroomId ? (
                  <Badge variant="success" size="sm">{`chatroom #${draft.kickChatroomId}`}</Badge>
                ) : null
              }
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <TextInput
                  value={draft.kickChannel}
                  onChange={(v) =>
                    set({ kickChannel: v, kickChatroomId: null })
                  }
                  placeholder="your channel — e.g. kick.com/yourname"
                  disabled={!draft.kickEnabled}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!draft.kickEnabled || !kickSlug || detecting || !token}
                  onClick={() => void detectKick()}
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {detecting ? "Detecting…" : "Detect chatroom id"}
                </Button>
              </div>
              {kickManualOpen && draft.kickEnabled ? (
                <div className="mt-2 space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <div className="text-caption font-semibold text-warning">
                    Kick blocked the automatic lookup — 20-second manual fix:
                  </div>
                  <ol className="list-inside list-decimal space-y-1 text-caption text-text-dim">
                    <li>
                      Open{" "}
                      <a
                        href={`https://kick.com/api/v2/channels/${kickSlug ?? ""}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent-cyan underline-offset-2 hover:underline"
                      >
                        kick.com/api/v2/channels/{kickSlug}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>{" "}
                      in a new tab (your own browser passes Kick's check).
                    </li>
                    <li>Select all (Ctrl+A), copy, and paste it below — we'll find the id.</li>
                  </ol>
                  <div className="flex flex-wrap items-center gap-2">
                    <TextInput
                      value={kickPaste}
                      onChange={setKickPaste}
                      placeholder="paste the page contents (or just the chatroom id number)"
                    />
                    <Button size="sm" variant="secondary" onClick={applyKickPaste}>
                      Apply
                    </Button>
                  </div>
                </div>
              ) : null}
            </PlatformRow>

            <PlatformRow
              label="YouTube"
              enabled={draft.youtubeEnabled}
              onToggle={(on) => set({ youtubeEnabled: on })}
              hint="Give your handle once — each stream's live chat is discovered automatically. No API key."
            >
              <TextInput
                value={draft.youtubeChannel}
                onChange={(v) => set({ youtubeChannel: v })}
                placeholder="@yourhandle, channel URL, or a live video URL"
                disabled={!draft.youtubeEnabled}
              />
            </PlatformRow>

            <PlatformRow
              label="TikTok"
              enabled={draft.tiktokEnabled}
              onToggle={(on) => set({ tiktokEnabled: on })}
              hint="Username only — no stream key needed, ever. Chat reads from your public LIVE; while you're offline the widget idles and auto-connects when you go live."
            >
              <TextInput
                value={draft.tiktokUsername}
                onChange={(v) => set({ tiktokUsername: v })}
                placeholder="@yourusername"
                disabled={!draft.tiktokEnabled}
              />
            </PlatformRow>

            <div className="border-t border-border pt-5">
              <SettingsMultiChatAppearance
                value={draft.appearance}
                onChange={(appearance) => set({ appearance })}
              />
            </div>

            <div className="border-t border-border pt-5">
              <SettingsMultiChatTts
                value={draft.tts}
                onChange={(tts) => set({ tts })}
                sound={draft.sound}
                onSoundChange={(sound) => set({ sound })}
              />
            </div>

            <div className="border-t border-border pt-5">
              <details className="group min-w-0" open={draft.translate.enabled}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-body font-medium text-text [&::-webkit-details-marker]:hidden">
                  <Languages className="h-4 w-4 text-accent-cyan" aria-hidden />
                  Translation
                  <span className="text-caption font-normal text-text-muted">
                    {draft.translate.enabled ? "on" : "off"} · click to{" "}
                    <span className="group-open:hidden">expand</span>
                    <span className="hidden group-open:inline">collapse</span>
                  </span>
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Toggle
                      checked={draft.translate.enabled}
                      onChange={(on) =>
                        set({ translate: { ...draft.translate, enabled: on } })
                      }
                      label="Enable chat translation"
                    />
                    <span className="text-body font-medium text-text">
                      Translate incoming chat
                    </span>
                  </div>
                  <p className="text-caption text-text-dim">
                    Works with any LibreTranslate-compatible API (self-hosted
                    or hosted). Messages are translated through our relay —
                    the endpoint and API key stay on the server and never
                    reach OBS.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block min-w-0">
                      <div className="mb-1 text-caption text-text-dim">
                        Endpoint URL <span className="text-text-muted">(https:// required)</span>
                      </div>
                      <input
                        type="url"
                        value={draft.translate.endpoint}
                        onChange={(e) =>
                          set({
                            translate: {
                              ...draft.translate,
                              endpoint: e.target.value,
                            },
                          })
                        }
                        placeholder="https://libretranslate.example.com/translate"
                        disabled={!draft.translate.enabled}
                        className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                      />
                    </label>
                    <label className="block min-w-0">
                      <div className="mb-1 text-caption text-text-dim">
                        API key <span className="text-text-muted">(if your provider needs one)</span>
                      </div>
                      <input
                        type="password"
                        value={draft.translate.apiKey}
                        onChange={(e) =>
                          set({
                            translate: {
                              ...draft.translate,
                              apiKey: e.target.value,
                            },
                          })
                        }
                        placeholder="optional"
                        autoComplete="off"
                        disabled={!draft.translate.enabled}
                        className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                      />
                    </label>
                    <label className="block min-w-0">
                      <div className="mb-1 text-caption text-text-dim">
                        Target language <span className="text-text-muted">(code, e.g. en, de, pt-br)</span>
                      </div>
                      <input
                        type="text"
                        value={draft.translate.targetLang}
                        onChange={(e) =>
                          set({
                            translate: {
                              ...draft.translate,
                              targetLang: e.target.value,
                            },
                          })
                        }
                        placeholder="en"
                        maxLength={8}
                        disabled={!draft.translate.enabled}
                        className="w-24 min-w-0 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                      />
                    </label>
                  </div>
                </div>
              </details>
            </div>

            {problems.length > 0 ? (
              <ul className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-text-dim">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}

            <div className="flex items-center gap-3">
              <Button
                onClick={() => void save()}
                disabled={saving || !dirty || problems.length > 0}
              >
                <MessageSquare className="mr-1.5 h-4 w-4" aria-hidden />
                {saving ? "Saving…" : "Save chat settings"}
              </Button>
              {dirty ? (
                <span className="text-caption text-text-muted">Unsaved changes</span>
              ) : null}
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}

function PlatformRow({
  label,
  enabled,
  onToggle,
  hint,
  badge,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  hint: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Toggle checked={enabled} onChange={onToggle} label={`Enable ${label} chat`} />
        <span className="text-body font-medium text-text">{label}</span>
        {badge}
      </div>
      <p className="text-caption text-text-dim">{hint}</p>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full min-w-0 max-w-md rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
    />
  );
}
