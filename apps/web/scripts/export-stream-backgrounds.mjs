import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const publicRoot = path.resolve("public", "stream-backgrounds");
const sourceRoot = path.join(publicRoot, "source");
const targets = [
  { directory: "4k", width: 3840, height: 2160 },
  { directory: "1080p", width: 1920, height: 1080 },
];

const sourceFiles = (await readdir(sourceRoot))
  .filter((name) => name.toLowerCase().endsWith(".png"))
  .sort();

if (sourceFiles.length === 0) {
  throw new Error(`No PNG source backgrounds found in ${sourceRoot}`);
}

for (const target of targets) {
  const outputRoot = path.join(publicRoot, target.directory);
  await mkdir(outputRoot, { recursive: true });

  for (const sourceFile of sourceFiles) {
    const input = path.join(sourceRoot, sourceFile);
    const output = path.join(outputRoot, sourceFile.replace(/\.png$/i, ".jpg"));
    await sharp(input)
      .resize({
        width: target.width,
        height: target.height,
        fit: "cover",
        position: "centre",
      })
      .sharpen({ sigma: 0.55 })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4", progressive: true })
      .toFile(output);
    console.log(`${target.directory}: ${path.basename(output)}`);
  }
}
