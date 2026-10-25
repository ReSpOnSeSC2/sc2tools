/** Tiny public continuation allowlist, generated from the rendered catalog. */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
const result = await build({ stdin: { contents: "export {BUILD_DEFINITIONS} from './lib/build-definitions';", resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "cjs", alias: { "@": process.cwd() }, logLevel: "silent" });
const metadata = { exports: {} };
// Only trusted repository metadata executes during offline generation.
new Function("module", "exports", "require", result.outputFiles[0].text)(metadata, metadata.exports, createRequire(import.meta.url));
const ids = [...new Set(metadata.exports.BUILD_DEFINITIONS.map(row => row.id))].sort();
writeFileSync("lib/buildVariantIds.generated.json", JSON.stringify(ids) + "\n");
console.log(`Build variant IDs: ${ids.length}`);
