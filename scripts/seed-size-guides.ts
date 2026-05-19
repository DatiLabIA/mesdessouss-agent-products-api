/**
 * Seed size guides from docs/guia de tallas/ into store_policies table.
 *
 * Each MD file becomes one row with clientId = "mesdessous" and a topic derived
 * from the filename (e.g. guide_tailles_aubade, guide_mesure_femme).
 *
 * Usage:
 *   pnpm seed:size-guides
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/prisma";

const CLIENT_ID = "mesdessous";
const GUIDES_DIR = path.join(__dirname, "../docs/guia de tallas");

/** Explicit mappings for filenames that don't follow the guide_tailles_X pattern. */
const SPECIAL_TOPICS: Record<string, string> = {
  "Comment mesurer sa taille de lingerie (Femme).md": "guide_mesure_femme",
  "Comment mesurer sa taille de sous-vêtements (Homme).md": "guide_mesure_homme",
};

function filenameToTopic(filename: string): string {
  if (SPECIAL_TOPICS[filename]) {
    return SPECIAL_TOPICS[filename];
  }
  return filename
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

async function main(): Promise<void> {
  const files = fs
    .readdirSync(GUIDES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  console.log(`[seed-size-guides] Found ${files.length} files in ${GUIDES_DIR}\n`);

  let upserted = 0;
  let errors = 0;

  for (const filename of files) {
    const topic = filenameToTopic(filename);
    const filePath = path.join(GUIDES_DIR, filename);
    const markdown = fs.readFileSync(filePath, "utf-8");

    try {
      await prisma.storePolicy.upsert({
        where: { clientId_topic: { clientId: CLIENT_ID, topic } },
        create: { clientId: CLIENT_ID, topic, content: { markdown } },
        update: { content: { markdown } },
      });
      console.log(`  ✓ ${topic}`);
      upserted++;
    } catch (err) {
      console.error(`  ✗ ${topic}:`, err);
      errors++;
    }
  }

  console.log(`\n[seed-size-guides] Done: ${upserted} upserted, ${errors} errors`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[seed-size-guides] Fatal error:", err);
  process.exit(1);
});
