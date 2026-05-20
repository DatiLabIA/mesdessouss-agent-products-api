/**
 * Sincronización de productos: XML feed -> PostgreSQL
 *
 * Descarga el catálogo XML (o usa archivo local como fallback),
 * consolida variaciones por referencia base y hace upsert en la BD.
 *
 * Uso:
 *   pnpm sync:products
 *
 * Cron (cada 4 horas):
 *   0 *\/4 * * * cd /app && pnpm sync:products >> /var/log/sync-products.log 2>&1
 */
import "dotenv/config";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";
import { prisma } from "../src/lib/prisma";
import { Prisma } from "@prisma/client";

const CLIENT_ID = "mesdessous";
const SOURCE_URL = process.env.BEDROCK_KB_SOURCE_URL ?? "";
const LOCAL_XML = path.join(__dirname, "650.ia_agent.xml");

// --- Tipos ---

interface ParsedProduct {
  name: string;
  brand: string;
  description: string;
  color: string;
  size: string;
  image1: string;
  linkvariation: string;
  gamme: string;
  material: string;
  type: string;
  forme: string;
  price: string;
  old_price: string;
  reference: string;
  link: string;
  gender: string;
  extraFields?: Record<string, string>;
}

interface ConsolidatedProduct extends ParsedProduct {
  product_url: string;
  allSizes: string[];
  allColors: string[];
  hasVariations: boolean;
  variationsCount: number;
}

// --- Helpers XML ---

function fixMojibake(str: string): string {
  if (!str || !/[\x80-\xff]/.test(str)) return str;
  try {
    const fixed = Buffer.from(str, "latin1").toString("utf8");
    return fixed.includes("\uFFFD") ? str : fixed;
  } catch {
    return str;
  }
}

function extractCDATA(xmlBlock: string, tagName: string): string {
  const regex = new RegExp(
    `<${tagName}><!\\[CDATA\\[([^\\]]*(?:\\][^\\]][^>]*)*)\\]\\]>`,
    "i"
  );
  const match = xmlBlock.match(regex);
  return match ? fixMojibake(match[1].trim()) : "";
}

const KNOWN_XML_TAGS = [
  "name", "brand", "description", "Couleur", "autotag_size", "image1",
  "linkvariation", "Gamme", "material", "Type", "Forme", "price",
  "old_price", "reference", "link", "gender",
];

function extractExtraFields(xmlBlock: string, knownTags: string[]): Record<string, string> {
  const knownSet = new Set(knownTags.map((t) => t.toLowerCase()));
  const extra: Record<string, string> = {};
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9_]*)><!\[CDATA\[/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xmlBlock)) !== null) {
    const tag = match[1];
    if (!knownSet.has(tag.toLowerCase())) {
      const value = extractCDATA(xmlBlock, tag);
      if (value) extra[tag] = value;
    }
  }
  return extra;
}

function parseXMLProducts(xmlContent: string): ParsedProduct[] {
  const blocks = xmlContent.split("<IA>").slice(1);
  return blocks.map((block) => {
    const product: ParsedProduct = {
      name: extractCDATA(block, "name"),
      brand: extractCDATA(block, "brand"),
      description: extractCDATA(block, "description"),
      color: extractCDATA(block, "Couleur"),
      size: extractCDATA(block, "autotag_size"),
      image1: extractCDATA(block, "image1"),
      linkvariation: extractCDATA(block, "linkvariation"),
      gamme: extractCDATA(block, "Gamme"),
      material: extractCDATA(block, "material"),
      type: extractCDATA(block, "Type"),
      forme: extractCDATA(block, "Forme"),
      price: extractCDATA(block, "price"),
      old_price: extractCDATA(block, "old_price"),
      reference: extractCDATA(block, "reference"),
      link: extractCDATA(block, "link"),
      gender: extractCDATA(block, "gender"),
    };
    const extraFields = extractExtraFields(block, KNOWN_XML_TAGS);
    if (Object.keys(extraFields).length > 0) product.extraFields = extraFields;
    return product;
  });
}

// --- Consolidar variaciones ---

function groupProductsByReference(products: ParsedProduct[]): ConsolidatedProduct[] {
  const groups = new Map<string, { base: ParsedProduct | null; variations: ParsedProduct[] }>();

  for (const product of products) {
    const ref = product.reference ?? "";
    const underscoreIdx = ref.indexOf("_");
    const baseRef = underscoreIdx > -1 ? ref.substring(0, underscoreIdx) : ref;
    const groupKey = `${product.brand ?? "Unknown"}|${baseRef || ref}`;

    if (!groups.has(groupKey)) groups.set(groupKey, { base: null, variations: [] });
    const group = groups.get(groupKey)!;
    if (underscoreIdx === -1) group.base = product;
    else group.variations.push(product);
  }

  const consolidated: ConsolidatedProduct[] = [];
  for (const [, group] of groups) {
    const base = group.base ?? group.variations[0];
    if (!base) continue;

    const sizes = new Set<string>();
    const colors = new Set<string>();
    if (base.size) sizes.add(base.size);
    if (base.color) colors.add(base.color);
    for (const v of group.variations) {
      if (v.size) sizes.add(v.size);
      if (v.color) colors.add(v.color);
    }

    consolidated.push({
      ...base,
      product_url: base.linkvariation || base.link || "",
      allSizes: [...sizes].filter(Boolean),
      allColors: [...colors].filter(Boolean),
      hasVariations: group.variations.length > 0,
      variationsCount: (group.base ? 1 : 0) + group.variations.length,
    });
  }

  return consolidated;
}

// --- Helpers ---

function extractCleanName(rawName: string): string {
  return rawName ? rawName.split(",")[0].trim() : "";
}

function cleanDescription(html: string, maxLength = 1500): string {
  if (!html) return "";
  const text = html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
}

function extractStyles(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase();
  const STYLES = ["sexy", "confort", "sport", "classique", "moderne", "vintage", "romantique", "elegant", "chic"];
  return STYLES.filter((s) => text.includes(s)).join(", ");
}

function calculateDiscount(price: number, oldPrice: number) {
  if (!price || !oldPrice || price >= oldPrice) return { hasDiscount: false, discountPct: 0 };
  return { hasDiscount: true, discountPct: Math.round(((oldPrice - price) / oldPrice) * 100) };
}

// --- Descarga XML ---

function downloadText(url: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error("Too many redirects")); return; }
    const client = url.startsWith("https://") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "datihub-sync/1.0" } }, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        resolve(downloadText(headers.location, redirectCount + 1));
        return;
      }
      if (statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.setTimeout(45_000, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
  });
}

async function loadXml(): Promise<string> {
  if (SOURCE_URL) {
    try {
      console.log("   Descargando XML desde URL...");
      const xml = await downloadText(SOURCE_URL);
      if (xml.includes("<IA>")) { console.log("   OK descargado"); return xml; }
      throw new Error("Contenido invalido");
    } catch (err) {
      console.warn(`   Descarga fallida (${(err as Error).message}), usando archivo local`);
    }
  }
  if (!fs.existsSync(LOCAL_XML)) {
    throw new Error(
      `No hay URL configurada ni archivo local en ${LOCAL_XML}.\n` +
      `Define BEDROCK_KB_SOURCE_URL en .env o coloca el XML en scripts/650.ia_agent.xml`
    );
  }
  console.log("   Usando XML local:", LOCAL_XML);
  return fs.readFileSync(LOCAL_XML, "utf-8");
}

// --- Main ---

async function main(): Promise<void> {
  console.log("Iniciando sincronizacion de productos MesDessous (XML -> DB)...\n");
  const startedAt = Date.now();

  console.log("Cargando XML...");
  const xmlContent = await loadXml();
  const allProducts = parseXMLProducts(xmlContent);
  console.log(`${allProducts.length} registros parseados del XML\n`);

  console.log("Consolidando variaciones...");
  const products = groupProductsByReference(allProducts);
  console.log(`${allProducts.length} registros -> ${products.length} productos unicos\n`);

  console.log("Sincronizando con la base de datos...");
  const activeRefs = new Set<string>();
  const rows: {
    clientId: string; productId: string; name: string;
    brand: string | null; type: string | null; subType: string | null;
    gender: string | null; price: number | null; oldPrice: number | null;
    hasDiscount: boolean; discountPct: number;
    color: string | null; sizes: string | null; materials: string | null;
    styles: string | null; collection: string | null;
    imageUrl: string | null; productUrl: string | null; description: string | null;
  }[] = [];

  for (const p of products) {
    if (!p.reference) continue;
    activeRefs.add(p.reference);
    const name = extractCleanName(p.name);
    const description = cleanDescription(p.description);
    const price = parseFloat(p.price) || null;
    const oldPrice = parseFloat(p.old_price) || null;
    const { hasDiscount, discountPct } = calculateDiscount(price ?? 0, oldPrice ?? 0);
    rows.push({
      clientId: CLIENT_ID,
      productId: p.reference,
      name,
      brand: p.brand || null,
      type: p.type || null,
      subType: p.forme || null,
      gender: p.gender || null,
      price,
      oldPrice,
      hasDiscount,
      discountPct,
      color: p.allColors.join(", ") || p.color || null,
      sizes: p.allSizes.join(", ") || null,
      materials: p.material || null,
      styles: extractStyles(p.name, p.description) || null,
      collection: p.gamme || null,
      imageUrl: p.image1 || null,
      productUrl: p.product_url || null,
      description,
    });
  }

  const BATCH_SIZE = 1000;
  const CONCURRENCY = 4;
  let upserted = 0;
  const now = new Date();

  const batches: typeof rows[] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (batch) => {
      const values = batch.map((r) =>
        Prisma.sql`(${r.clientId}, ${r.productId}, ${r.name},
          ${r.brand}, ${r.type}, ${r.subType}, ${r.gender},
          ${r.price}, ${r.oldPrice}, ${r.hasDiscount}, ${r.discountPct},
          ${r.color}, ${r.sizes}, ${r.materials}, ${r.styles},
          ${r.collection}, ${r.imageUrl}, ${r.productUrl}, ${r.description},
          true, ${now})`
      );
      await prisma.$executeRaw`
        INSERT INTO products (
          client_id, product_id, name,
          brand, type, sub_type, gender,
          price, old_price, has_discount, discount_pct,
          color, sizes, materials, styles,
          collection, image_url, product_url, description,
          active, synced_at
        )
        VALUES ${Prisma.join(values)}
        ON CONFLICT (client_id, product_id)
        DO UPDATE SET
          name        = EXCLUDED.name,
          brand       = EXCLUDED.brand,
          type        = EXCLUDED.type,
          sub_type    = EXCLUDED.sub_type,
          gender      = EXCLUDED.gender,
          price       = EXCLUDED.price,
          old_price   = EXCLUDED.old_price,
          has_discount = EXCLUDED.has_discount,
          discount_pct = EXCLUDED.discount_pct,
          color       = EXCLUDED.color,
          sizes       = EXCLUDED.sizes,
          materials   = EXCLUDED.materials,
          styles      = EXCLUDED.styles,
          collection  = EXCLUDED.collection,
          image_url   = EXCLUDED.image_url,
          product_url = EXCLUDED.product_url,
          description = EXCLUDED.description,
          active      = true,
          synced_at   = EXCLUDED.synced_at
      `;
      upserted += batch.length;
      process.stdout.write(`\r   ${upserted}/${rows.length} productos sincronizados...`);
    }));
  }
  console.log();

  const deactivated = await prisma.product.updateMany({
    where: { clientId: CLIENT_ID, active: true, NOT: { productId: { in: [...activeRefs] } } },
    data: { active: false, syncedAt: new Date() },
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\nSincronizacion completada:");
  console.log(`  Actualizados/creados : ${upserted}`);
  console.log(`  Desactivados         : ${deactivated.count}`);
  console.log(`  Tiempo               : ${elapsed}s`);
}

main()
  .catch((err) => { console.error("Error fatal:", err); process.exit(1); })
  .finally(() => prisma.$disconnect());
