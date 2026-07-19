"use client";

/**
 * ChatBotCard — Settings surface for the Twitch chat bot that TALKS
 * BACK in chat: it answers !rank / !mmr / !opponent / !build where
 * the question was asked, counts !win/!loss votes and XP even when
 * no overlay chat source is open, and announces Crystal Ball
 * opens/settles and level-ups.
 *
 * Credentials: a bot account username + an OAuth chat token, stored
 * server-side only — the GET view is masked (``hasToken``), and
 * saving with the password field untouched keeps the stored token.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Bot, RefreshCw } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";

interface BotView {
  enabled: boolean;
  username: string;
  channel: string;
  replyCommands: boolean;
  announceOracle: boolean;
  announceLevelUps: boolean;
  hasToken: boolean;
  status: {
    state: string;
    channel: string | null;
    lastError: string | null;
    lastConnectedAt: number | null;
  };
}

const STATE_LABEL: Record<string, { text: string; tone: string }> = {
  off: { text: "Off", tone: "text-text-muted" },
  connecting: { text: "Connecting…", tone: "text-warning" },
  connected: { text: "Connected — live in chat", tone: "text-success" },
  auth_failed: { text: "Login failed — new token needed", tone: "text-danger" },
  error: { text: "Error", tone: "text-danger" },
};

export function ChatBotCard({ twitchChannel }: { twitchChannel: string }) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data, mutate } = useApi<BotView>("/v1/me/chatbot");

  const [draft, setDraft] = useState({
    enabled: false,
    username: "",
    channel: "",
    token: "",
    replyCommands: true,
    announceOracle: true,
    announceLevelUps: true,
  });
  const [hasToken, setHasToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    setDraft({
      enabled: data.enabled,
      username: data.username,
      channel: data.channel,
      token: "",
      replyCommands: data.replyCommands,
      announceOracle: data.announceOracle,
      announceLevelUps: data.announceLevelUps,
    });
    setHasToken(data.hasToken);
  }, [data, dirty]);

  const set = useCallback((patch: Partial<typeof draft>) => {
    setDirty(true);
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiCall<BotView>(getToken, "/v1/me/chatbot", {
        method: "PUT",
        body: JSON.stringify({
          ...draft,
          channel: draft.channel || twitchChannel || draft.username,
        }),
      });
      setDirty(false);
      setHasToken(res.hasToken);
      await mutate();
      toast.success(
        res.enabled
          ? "Chat bot saved — connecting to Twitch chat."
          : "Chat bot saved.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const status = data?.status ?? {
    state: "off",
    channel: null,
    lastError: null,
    lastConnectedAt: null,
  };
  const stateMeta = STATE_LABEL[status.state] ?? STATE_LABEL.off;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-body font-medium text-text">
          <Bot className="h-4 w-4 text-accent-cyan" aria-hidden />
          Chat bot — answers in chat
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-caption ${stateMeta.tone}`}>{stateMeta.text}</span>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh bot status"
            onClick={() => void mutate()}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <p className="text-caption text-text-dim">
        Replies to <b>!rank</b>, <b>!mmr</b>, <b>!opponent</b> and{" "}
        <b>!build</b> right in Twitch chat, counts <b>!win</b>/<b>!loss</b>{" "}
        calls and XP even with the dock closed, and announces Crystal Ball
        results and level-ups. Use a separate bot account or your own —
        it needs a chat OAuth token (scopes <code>chat:read</code> +{" "}
        <code>chat:edit</code>), e.g. via{" "}
        <a
          href="https://twitchtokengenerator.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-cyan underline underline-offset-2"
        >
          twitchtokengenerator.com
        </a>
        . The token is stored server-side and never shown again.
      </p>
      {status.lastError ? (
        <p className="text-caption text-danger">{status.lastError}</p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-44 min-w-0">
          <div className="mb-1 text-caption text-text-dim">Bot username</div>
          <input
            type="text"
            value={draft.username}
            onChange={(e) => set({ username: e.target.value })}
            placeholder="sc2toolsbot"
            className="w-full rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block w-56 min-w-0">
          <div className="mb-1 text-caption text-text-dim">
            OAuth token{hasToken ? " (saved)" : ""}
          </div>
          <input
            type="password"
            value={draft.token}
            onChange={(e) => set({ token: e.target.value })}
            placeholder={hasToken ? "•••••••• (leave blank to keep)" : "oauth:…"}
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block w-44 min-w-0">
          <div className="mb-1 text-caption text-text-dim">Channel</div>
          <input
            type="text"
            value={draft.channel}
            onChange={(e) => set({ channel: e.target.value })}
            placeholder={twitchChannel || "your channel"}
            className="w-full rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-caption text-text">
          <Toggle
            checked={draft.replyCommands}
            onChange={(on) => set({ replyCommands: on })}
            label="Reply to commands"
          />
          Reply to commands
        </label>
        <label className="flex items-center gap-2 text-caption text-text">
          <Toggle
            checked={draft.announceOracle}
            onChange={(on) => set({ announceOracle: on })}
            label="Announce Crystal Ball"
          />
          Announce Crystal Ball
        </label>
        <label className="flex items-center gap-2 text-caption text-text">
          <Toggle
            checked={draft.announceLevelUps}
            onChange={(on) => set({ announceLevelUps: on })}
            label="Announce level-ups"
          />
          Announce level-ups
        </label>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-body text-text">
          <Toggle
            checked={draft.enabled}
            onChange={(on) => set({ enabled: on })}
            label="Enable chat bot"
          />
          Enable
        </label>
        <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save bot settings"}
        </Button>
      </div>
    </div>
  );
}
