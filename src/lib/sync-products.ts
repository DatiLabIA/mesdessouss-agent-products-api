/**
 * Lógica de sincronización XML → PostgreSQL.
 * Exportada para ser usada tanto desde el script CLI como desde el scheduler del servidor.
 */
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";
import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

const CLIENT_ID = "mesdessous";
const LOCAL_XML = path.join(__dirname, "../../scripts/650.ia_agent.xml");

// --- Tipos ---

interface ParsedProduct {
  name: string; brand: string; description: string; color: string;
  size: string; image1: string; linkvariation: string; gamme: string;
  material: string; type: string; forme: string; price: string;
  old_price: string; reference: string; link: string; gender: string;
  quantity: string;
  extraFields?: Record<string, string>;
}

interface FlatProduct {
  baseRef: string;
  reference: string;
  name: string; brand: string; description: string;
  color: string; size: string;
  image1: string; gamme: string; material: string;
  type: string; forme: string; price: string; old_price: string;
  link: string; gender: string; quantity: string;
  product_url: string;
}

// --- Helpers XML ---

function fixMojibake(str: string): string {
  if (!str || !/[\x80-\xff]/.test(str)) return str;
  try {
    const fixed = Buffer.from(str, "latin1").toString("utf8");
    return fixed.includes("\uFFFD") ? str : fixed;
  } catch { return str; }
}

function extractCDATA(xmlBlock: string, tagName: string): string {
  const regex = new RegExp(
    `<${tagName}><!\\[CDATA\\[([^\\]]*(?:\\][^\\]][^>]*)*)\\]\\]>`, "i"
  );
  const match = xmlBlock.match(regex);
  return match ? fixMojibake(match[1].trim()) : "";
}

const KNOWN_XML_TAGS = [
  "name", "brand", "description", "Couleur", "autotag_size", "image1",
  "linkvariation", "Gamme", "material", "Type", "Forme", "price",
  "old_price", "reference", "link", "gender", "quantity",
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
      name: extractCDATA(block, "name"), brand: extractCDATA(block, "brand"),
      description: extractCDATA(block, "description"), color: extractCDATA(block, "Couleur"),
      size: extractCDATA(block, "autotag_size"), image1: extractCDATA(block, "image1"),
      linkvariation: extractCDATA(block, "linkvariation"), gamme: extractCDATA(block, "Gamme"),
      material: extractCDATA(block, "material"), type: extractCDATA(block, "Type"),
      forme: extractCDATA(block, "Forme"), price: extractCDATA(block, "price"),
      old_price: extractCDATA(block, "old_price"), reference: extractCDATA(block, "reference"),
      link: extractCDATA(block, "link"), gender: extractCDATA(block, "gender"),
      quantity: extractCDATA(block, "quantity"),
    };
    const extraFields = extractExtraFields(block, KNOWN_XML_TAGS);
    if (Object.keys(extraFields).length > 0) product.extraFields = extraFields;
    return product;
  });
}

function flattenProducts(products: ParsedProduct[]): FlatProduct[] {
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

  const flat: FlatProduct[] = [];
  for (const [, group] of groups) {
    const base = group.base ?? group.variations[0];
    if (!base) continue;
    const baseRef = base.reference.split("_")[0] || base.reference;

    if (group.variations.length === 0) {
      // Producto sin variaciones → una sola fila
      flat.push({
        baseRef,
        reference: base.reference,
        name: base.name, brand: base.brand, description: base.description,
        color: base.color, size: base.size,
        image1: base.image1, gamme: base.gamme, material: base.material,
        type: base.type, forme: base.forme, price: base.price, old_price: base.old_price,
        link: base.link, gender: base.gender, quantity: base.quantity,
        product_url: base.linkvariation || base.link || "",
      });
    } else {
      // Producto con variaciones → una fila por variación
      for (const v of group.variations) {
        flat.push({
          baseRef,
          reference: v.reference,
          name: base.name, brand: base.brand, description: base.description,
          color: v.color, size: v.size,
          image1: base.image1, gamme: base.gamme, material: base.material,
          type: base.type, forme: base.forme, price: base.price, old_price: base.old_price,
          link: base.link, gender: base.gender, quantity: v.quantity,
          product_url: v.linkvariation || base.link || "",
        });
      }
    }
  }
  return flat;
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/(https?:\/\/[^\/]+)\/[a-z]{2}\//i, "$1/");
}

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

function downloadText(url: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error("Too many redirects")); return; }
    const client = url.startsWith("https://") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "datihub-sync/1.0" } }, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); resolve(downloadText(headers.location, redirectCount + 1)); return;
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
  const sourceUrl = process.env.BEDROCK_KB_SOURCE_URL ?? "";
  if (sourceUrl) {
    try {
      console.log("[sync] Descargando XML desde URL...");
      const xml = await downloadText(sourceUrl);
      if (xml.includes("<IA>")) { console.log("[sync] XML descargado OK"); return xml; }
      throw new Error("Contenido invalido");
    } catch (err) {
      console.warn(`[sync] Descarga fallida (${(err as Error).message}), usando archivo local`);
    }
  }
  if (!fs.existsSync(LOCAL_XML)) {
    throw new Error(`No hay URL configurada ni archivo local en ${LOCAL_XML}`);
  }
  console.log("[sync] Usando XML local:", LOCAL_XML);
  return fs.readFileSync(LOCAL_XML, "utf-8");
}

// --- Función principal exportada ---

export async function syncProducts(): Promise<void> {
  const startedAt = Date.now();
  console.log("[sync] Iniciando sincronizacion de productos...");

  const xmlContent = await loadXml();
  const allProducts = parseXMLProducts(xmlContent);
  console.log(`[sync] ${allProducts.length} registros parseados`);

  const products = flattenProducts(allProducts);
  console.log(`[sync] ${products.length} variaciones planas generadas`);

  const activeRefs = new Set<string>();
  type SyncRow = {
    clientId: string; productId: string; baseProductId: string; name: string;
    brand: string | null; type: string | null; subType: string | null;
    gender: string | null; price: number | null; oldPrice: number | null;
    hasDiscount: boolean; discountPct: number;
    color: string | null; sizes: string | null; materials: string | null;
    styles: string | null; collection: string | null;
    imageUrl: string | null; productUrl: string | null; description: string | null;
    quantity: number | null;
  };
  const rows: SyncRow[] = [];

  for (const p of products) {
    if (!p.reference) continue;
    activeRefs.add(p.reference);
    const price = parseFloat(p.price) || null;
    const oldPrice = parseFloat(p.old_price) || null;
    const { hasDiscount, discountPct } = calculateDiscount(price ?? 0, oldPrice ?? 0);
    rows.push({
      clientId: CLIENT_ID, productId: p.reference, baseProductId: p.baseRef,
      name: extractCleanName(p.name),
      brand: p.brand || null, type: p.type || null, subType: p.forme || null,
      gender: p.gender || null, price, oldPrice, hasDiscount, discountPct,
      color: p.color || null,
      sizes: p.size || null,
      materials: p.material || null,
      styles: extractStyles(p.name, p.description) || null,
      collection: p.gamme || null, imageUrl: p.image1 || null,
      productUrl: normalizeUrl(p.product_url) || null,
      description: cleanDescription(p.description),
      quantity: p.quantity ? parseInt(p.quantity, 10) || null : null,
    });
  }

  const BATCH_SIZE = 1000;
  const CONCURRENCY = 4;
  let upserted = 0;
  const now = new Date();
  const batches: SyncRow[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(async (batch) => {
      const values = batch.map((r) =>
        Prisma.sql`(${r.clientId}, ${r.productId}, ${r.baseProductId}, ${r.name},
          ${r.brand}, ${r.type}, ${r.subType}, ${r.gender},
          ${r.price}, ${r.oldPrice}, ${r.hasDiscount}, ${r.discountPct},
          ${r.color}, ${r.sizes}, ${r.materials}, ${r.styles},
          ${r.collection}, ${r.imageUrl}, ${r.productUrl}, ${r.description},
          ${r.quantity}, true, ${now})`
      );
      await prisma.$executeRaw`
        INSERT INTO products (
          client_id, product_id, base_product_id, name,
          brand, type, sub_type, gender,
          price, old_price, has_discount, discount_pct,
          color, sizes, materials, styles,
          collection, image_url, product_url, description,
          quantity, active, synced_at
        )
        VALUES ${Prisma.join(values)}
        ON CONFLICT (client_id, product_id)
        DO UPDATE SET
          base_product_id = EXCLUDED.base_product_id,
          name         = EXCLUDED.name,
          brand        = EXCLUDED.brand,
          type         = EXCLUDED.type,
          sub_type     = EXCLUDED.sub_type,
          gender       = EXCLUDED.gender,
          price        = EXCLUDED.price,
          old_price    = EXCLUDED.old_price,
          has_discount = EXCLUDED.has_discount,
          discount_pct = EXCLUDED.discount_pct,
          color        = EXCLUDED.color,
          sizes        = EXCLUDED.sizes,
          materials    = EXCLUDED.materials,
          styles       = EXCLUDED.styles,
          collection   = EXCLUDED.collection,
          image_url    = EXCLUDED.image_url,
          product_url  = EXCLUDED.product_url,
          description  = EXCLUDED.description,
          quantity     = EXCLUDED.quantity,
          active       = true,
          synced_at    = EXCLUDED.synced_at
      `;
      upserted += batch.length;
    }));
    console.log(`[sync] ${Math.min(upserted, rows.length)}/${rows.length} productos sincronizados...`);
  }

  const deactivated = await prisma.product.updateMany({
    where: { clientId: CLIENT_ID, active: true, NOT: { productId: { in: [...activeRefs] } } },
    data: { active: false, syncedAt: new Date() },
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[sync] Completado: ${upserted} upserted, ${deactivated.count} desactivados — ${elapsed}s`);
}
