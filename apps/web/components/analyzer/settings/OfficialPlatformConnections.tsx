"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

type OfficialPlatform = "twitch" | "kick" | "youtube";

type ConnectionStatus = {
  platform: OfficialPlatform;
  configured: boolean;
  streamingAvailable?: boolean;
  streamingConsent?: boolean;
  connected: boolean;
  ready: boolean;
  platformUserName: string;
  scopes: string[];
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

type ConnectionsResponse = { platforms: ConnectionStatus[] };

const COPY: Record<OfficialPlatform, { label: string; coverage: string }> = {
  twitch: {
    label: "Twitch",
    coverage: "Adds signed follows, channel-point rewards, subs, resubs, gift subs, cheers and incoming raids. Live-chat copies are paired automatically, so each action appears once.",
  },
  kick: {
    label: "Kick",
    coverage: "Adds signed follows, channel rewards, new and renewed subscriptions, gifted subs and KICKs gifts. Live-chat copies are paired automatically.",
  },
  youtube: {
    label: "YouTube",
    coverage: "Adds free channel-subscription alerts for subscribers who keep their subscriptions public. YouTube hides private subscriptions.",
  },
};

export function OfficialPlatformConnections() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useApi<ConnectionsResponse>(
    "/v1/me/integrations",
    { refreshInterval: 60_000 },
  );
  const [busy, setBusy] = useState<OfficialPlatform | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = async (platform: OfficialPlatform, purpose: "alerts" | "streaming" = "alerts") => {
    const baselineConnectedAt = data?.platforms.find(
      (item) => item.platform === platform,
    )?.connectedAt || null;
    // Open synchronously from the click so popup blockers do not swallow the
    // OAuth window while the authenticated API request is in flight.
    const popup = window.open("", "sc2tools-platform-connect", "popup,width=620,height=760");
    if (!popup) {
      toast.error("Your browser blocked the connection window", {
        description: "Allow popups for SC2 Tools, then try again.",
      });
      return;
    }
    popup.document.title = `Connect ${COPY[platform].label}`;
    popup.document.body.textContent = `Opening ${COPY[platform].label}…`;
    setBusy(platform);
    try {
      const result = await apiCall<{ authorizeUrl: string }>(
        getToken,
        `/v1/me/integrations/${platform}/connect`,
        { method: "POST", body: purpose === "streaming" ? JSON.stringify({ purpose }) : "{}" },
      );
      popup.location.replace(result.authorizeUrl);
      let lastPollError: unknown = null;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await wait(2_000);
        if (!mounted.current) return;
        let fresh: ConnectionsResponse;
        try {
          fresh = await apiCall<ConnectionsResponse>(
            getToken,
            "/v1/me/integrations",
          );
          lastPollError = null;
        } catch (err) {
          // A brief API/network interruption should not cancel a provider flow
          // the viewer may still be completing in the popup.
          lastPollError = err;
          if (popup.closed) break;
          continue;
        }
        await mutate(fresh, false);
        const row = fresh.platforms.find((item) => item.platform === platform);
        // A reconnect starts while the old row is still connected. Only treat
        // a status as this popup's result after the callback installs a fresh
        // connection revision (represented publicly by connectedAt).
        const completedThisFlow = Boolean(
          row?.connectedAt && row.connectedAt !== baselineConnectedAt,
        );
        if (purpose === "streaming" && completedThisFlow && row?.connected && row.streamingConsent) {
          popup.close();
          toast.success(`${COPY[platform].label} stream controls connected`, {
            description: "Return to the SC2Tools agent to set your stream title and prepare supported sessions.",
          });
          return;
        }
        if (completedThisFlow && row?.connected && row.ready) {
          popup.close();
          if (row.lastError) {
            toast.error(`${COPY[platform].label} connected, but alerts need a retry`, {
              description: row.lastError,
            });
          } else {
            toast.success(`${COPY[platform].label} connected`, {
              description: "Supported notifications will now appear on stream and in Stream Dock.",
            });
          }
          return;
        }
        if (completedThisFlow && row?.connected && row.lastError) {
          popup.close();
          toast.error(`${COPY[platform].label} connected, but alerts need a retry`, {
            description: row.lastError,
          });
          return;
        }
        if (popup.closed) break;
      }
      await mutate();
      popup.close();
      toast.error(`${COPY[platform].label} connection was not completed`, {
        description: lastPollError
          ? "Connection status was temporarily unavailable. Check the account status below and retry if needed."
          : undefined,
      });
    } catch (err) {
      popup.close();
      toast.error(`Could not connect ${COPY[platform].label}`, {
        description: errorMessage(err),
      });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const disconnect = async (platform: OfficialPlatform) => {
    if (!window.confirm(`Disconnect your ${COPY[platform].label} account? This stops its notifications and stream controls.`)) return;
    setBusy(platform);
    try {
      await apiCall(getToken, `/v1/me/integrations/${platform}`, {
        method: "DELETE",
      });
      await mutate();
      toast.success(`${COPY[platform].label} disconnected`);
    } catch (err) {
      toast.error(`Could not disconnect ${COPY[platform].label}`, {
        description: errorMessage(err),
      });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
      <div>
        <div className="text-body font-medium text-text">Connected accounts</div>
        <p className="mt-1 text-caption text-text-dim">
          Connect your accounts for notifications. Choose Connect stream controls to
          let SC2Tools update stream titles and prepare your YouTube broadcasts.
          You can remove a connection here at any time.
        </p>
      </div>
      {isLoading ? (
        <div className="text-caption text-text-muted">Checking connections…</div>
      ) : error && !data ? (
        <div className="flex items-center gap-2 text-caption text-danger">
          Couldn&apos;t check notification accounts.
          <Button size="sm" variant="secondary" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {(["twitch", "kick", "youtube"] as OfficialPlatform[]).map((platform) => {
            const row = data?.platforms.find((item) => item.platform === platform);
            const configured = row?.configured === true;
            const connected = row?.connected === true;
            return (
              <div key={platform} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-medium text-text">{COPY[platform].label}</span>
                    {connected && row?.ready ? (
                      <Badge variant="success" size="sm">Connected</Badge>
                    ) : connected ? (
                      <Badge variant="warning" size="sm">Needs retry</Badge>
                    ) : configured ? (
                      <Badge variant="neutral" size="sm">Not connected</Badge>
                    ) : (
                      <Badge variant="neutral" size="sm">Not available</Badge>
                    )}
                    {connected && row?.platformUserName ? (
                      <span className="text-caption text-text-muted">{row.platformUserName}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-caption text-text-dim">{COPY[platform].coverage}</p>
                  {row?.streamingConsent ? (
                    <p className="mt-1 text-caption text-success">Stream control permissions connected.</p>
                  ) : null}
                  {row?.lastError ? (
                    <p className="mt-1 text-caption text-danger">{row.lastError}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                {connected ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void connect(platform, row?.streamingConsent ? "streaming" : "alerts")}
                    >
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void disconnect(platform)}
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!configured || busy !== null}
                    onClick={() => void connect(platform)}
                  >
                    {busy === platform ? "Connecting…" : "Connect"}
                  </Button>
                )}
                {!row?.streamingConsent ? (
                  <Button size="sm" variant="secondary"
                    disabled={!configured || row?.streamingAvailable !== true || busy !== null}
                    onClick={() => void connect(platform, "streaming")}
                  >
                    Connect stream controls
                  </Button>
                ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-micro text-text-muted">
        TikTok chat, follows, gifts/diamonds, shares and likes continue through
        the live TikTok connection above; TikTok does not provide a public
        creator webhook connection for these LIVE events.
      </p>
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Try again in a moment.";
}
