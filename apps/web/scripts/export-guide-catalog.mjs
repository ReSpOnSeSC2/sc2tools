// Export the build-guide catalog for the API.
//
//   npm run guides:catalog        (from apps/web)
//
// The API image does not ship apps/web, so the guide catalog it needs at
// require time (apps/api/src/config/guideCatalog.json) is generated from
// the web's BUILD_DEFINITIONS here and committed. The build-definitions
// chunks use two authoring styles (object literals and helper calls), so
// the catalog is BUNDLED with the esbuild that ships in apps/web's
// node_modules rather than scraped with a regex. Entry point is
// lib/guides/catalog.ts, which imports lib/build-definitions.ts and owns
// GUIDE_NON_OPENER_IDS. The vitest drift test in
// lib/guides/__tests__/slugs.test.ts fails until this is re-run after a
// catalog change.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(webRoot, "lib", "guides", "catalog.ts");
const outFile = path.resolve(webRoot, "..", "api", "src", "config", "guideCatalog.json");
const JSON_INDENT = 2;

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "warning",
  absWorkingDir: webRoot,
  alias: { "@": webRoot },
});

const [bundle] = result.outputFiles;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.contents).toString("base64")}`;
const { buildGuideCatalog } = await import(moduleUrl);
const catalog = buildGuideCatalog();

const names = new Set(catalog.map((entry) => entry.name));
if (catalog.length === 0 || names.size !== catalog.length) {
  throw new Error(`guide catalog is empty or has duplicate names (${catalog.length} entries)`);
}

writeFileSync(outFile, `${JSON.stringify(catalog, null, JSON_INDENT)}\n`);
const openers = catalog.filter((entry) => entry.opener).length;
console.log(`${path.relative(webRoot, outFile)}: ${catalog.length} entries, ${openers} openers`);
