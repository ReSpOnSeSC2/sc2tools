import { ImageResponse } from "next/og";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";

export const alt = "Shared StarCraft II replay archive on SC2 Tools";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 0;

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

export default async function ReplayOpenGraphImage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const archive = await loadArchive(handle);
  const displayName = archive?.profile.displayName || "Shared replays";
  const latest = archive?.items[0];

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "68px 76px",
        color: "#e7edf0",
        background: "radial-gradient(900px 520px at 100% 0%, #157d8c55 0%, #06090e 58%), #06090e",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ display: "flex", width: 14, height: 42, borderRadius: 7, background: "#3ce0d6" }} />
        <div style={{ display: "flex", fontSize: 30, fontWeight: 800, letterSpacing: 4, color: "#3ce0d6" }}>
          SC2 TOOLS · REPLAYS
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", maxWidth: 1040, fontSize: 78, lineHeight: 1.04, fontWeight: 800 }}>
          {truncate(`${displayName}'s replay archive`, 38)}
        </div>
        <div style={{ display: "flex", fontSize: 31, color: "#9aa3b2" }}>
          Analysis · macro breakdowns · stream POVs · original replay downloads
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
        <div style={{ display: "flex", fontSize: 25, color: "#9aa3b2" }}>
          {latest?.map ? `Latest game · ${truncate(latest.map, 38)}` : "A private-by-default shared match tape"}
        </div>
        <div style={{ display: "flex", padding: "12px 22px", border: "2px solid #157d8c", borderRadius: 999, fontSize: 23, fontWeight: 700, color: "#3ce0d6" }}>
          View on SC2 Tools
        </div>
      </div>
    </div>,
    size,
  );
}

async function loadArchive(handle: string): Promise<ReplayLibraryResponse | null> {
  try {
    const response = await fetch(
      `${API_BASE}/v1/public/replays/${encodeURIComponent(handle)}?limit=1`,
      { headers: { accept: "application/json" }, cache: "no-store" },
    );
    if (!response.ok) return null;
    return await response.json() as ReplayLibraryResponse;
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
