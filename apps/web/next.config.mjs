import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build-time guard: the SC2 icon library must be present for the Icon
// primitive to resolve names. Phase 0 copies icons from
// reveal-sc2-opponent-main/SC2-Overlay/icons/ into public/icons/sc2/.
const iconsDir = join(__dirname, "public", "icons", "sc2");
if (!existsSync(iconsDir)) {
  throw new Error(
    `[next.config] Missing SC2 icon directory at ${iconsDir}. ` +
      `Run the icon copy step or restore from reveal-sc2-opponent-main/SC2-Overlay/icons/.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Tighten the cache for the analyzer page so it always reflects the
  // user's latest data, but let the marketing routes use Vercel's edge.
  async headers() {
    return [
      {
        source: "/app/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/devices",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
