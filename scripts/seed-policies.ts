/**
 * Seed SAV knowledge base from docs/knowledge_base_SAV_mesdessous.md
 * into store_policies table, split by H2 section.
 *
 * Topics created:
 *   boutique_info | livraison | retours | paiement | codes_promo
 *   compte_client | tailles_faq | produits | international | contact
 *   mentions_legales | lexique_statuts | agent_notes
 *
 * Usage:
 *   pnpm seed:policies
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/prisma";

const CLIENT_ID = "mesdessous";
const SAV_KB_PATH = path.join(__dirname, "../docs/knowledge_base_SAV_mesdessous.md");

/** Maps a keyword found in the H2 heading to a stable topic slug. */
const HEADING_TO_TOPIC: Array<[string, string]> = [
  ["Présentation", "boutique_info"],
  ["LIVRAISON", "livraison"],
  ["RETOURS", "retours"],
  ["COMMANDES", "paiement"],
  ["CODES PROMO", "codes_promo"],
  ["COMPTE CLIENT", "compte_client"],
  ["TAILLES", "tailles_faq"],
  ["PRODUITS", "produits"],
  ["INTERNATIONAL", "international"],
  ["CONTACT", "contact"],
  ["MENTIONS", "mentions_legales"],
  ["LEXIQUE", "lexique_statuts"],
  ["NOTES POUR", "agent_notes"],
];

function headingToTopic(heading: string): string | null {
  for (const [keyword, topic] of HEADING_TO_TOPIC) {
    if (heading.includes(keyword)) return topic;
  }
  return null;
}

interface Section {
  topic: string;
  content: string;
}

function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let currentTopic: string | null = null;
  let currentLines: string[] = [];

  for (const line of markdown.split("\n")) {
    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      if (currentTopic && currentLines.length) {
        sections.push({ topic: currentTopic, content: currentLines.join("\n").trim() });
      }
      currentTopic = headingToTopic(h2Match[1]);
      currentLines = [line];
    } else if (currentTopic) {
      currentLines.push(line);
    }
  }

  if (currentTopic && currentLines.length) {
    sections.push({ topic: currentTopic, content: currentLines.join("\n").trim() });
  }

  return sections;
}

async function main(): Promise<void> {
  const markdown = fs.readFileSync(SAV_KB_PATH, "utf-8");
  const sections = parseSections(markdown);

  console.log(`[seed-policies] Found ${sections.length} sections\n`);

  let upserted = 0;
  let errors = 0;

  for (const section of sections) {
    try {
      await prisma.storePolicy.upsert({
        where: { clientId_topic: { clientId: CLIENT_ID, topic: section.topic } },
        create: { clientId: CLIENT_ID, topic: section.topic, content: { markdown: section.content } },
        update: { content: { markdown: section.content } },
      });
      console.log(`  ✓ ${section.topic}`);
      upserted++;
    } catch (err) {
      console.error(`  ✗ ${section.topic}:`, err);
      errors++;
    }
  }

  console.log(`\n[seed-policies] Done: ${upserted} upserted, ${errors} errors`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[seed-policies] Fatal error:", err);
  process.exit(1);
});
