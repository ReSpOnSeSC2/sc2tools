#!/usr/bin/env node
// Local-only visual fixture harness. Never included in the public app build.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(root, "../..");
const hooks = path.join(root, "fixture-hooks.ts");
const mocked = [
  "useStudioState", "useTestFireFlag", "useEngagementState", "useMultiChat",
  "useEngagementReporter", "useTickerFacts", "useChatSound", "useChatTts",
  "useEventSounds", "useAlertMediaGrant", "useCommandAnswers", "useTranslation",
  "useOverlayBuildRefresh", "revealSound", "widgetAudio", "clientApi", "map-images",
];

const server = await createServer({
  configFile: false,
  root,
  publicDir: path.join(webRoot, "public"),
  plugins: [
    {
      name: "original-fixture-modules",
      enforce: "pre",
      resolveId(source) {
        if (!source.startsWith("fixture-original:")) return;
        const name = source.slice("fixture-original:".length);
        const modules = {
          studio: "lib/multichat/useStudioState.ts",
          engagement: "lib/multichat/useEngagementState.ts",
          refresh: "components/overlay/useOverlayBuildRefresh.ts",
          maps: "lib/map-images.ts",
        };
        return modules[name] ? path.join(webRoot, modules[name]) : null;
      },
    },
    react(),
  ],
  resolve: { alias: [
    ...mocked.map((name) => ({ find: new RegExp(`^(?:.*/)?${name}$`), replacement: hooks })),
    { find: "@", replacement: webRoot },
  ] },
  css: { postcss: webRoot },
  define: { "process.env": JSON.stringify({ NODE_ENV: "development", NEXT_PUBLIC_API_BASE: "/fixture-api" }) },
  server: { host: "127.0.0.1", port: Number(process.env.WIDGET_EXAMPLES_PORT || 4317), strictPort: true, hmr: false, fs: { allow: [webRoot] } },
  optimizeDeps: { include: ["react", "react-dom/client", "lucide-react"] },
});
await server.listen();
server.printUrls();
