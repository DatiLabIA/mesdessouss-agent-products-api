#!/usr/bin/env node

/**
 * Preparar Productos para AWS Bedrock Knowledge Base (desde XML)
 *
 * Este script lee el catálogo XML exportado (650.ia_agent.xml),
 * procesa todos los productos (linkvariation es opcional),
 * y genera UN archivo JSON por producto con metadataAttributes + content
 * listo para subir a S3 y ser indexado por Bedrock KB.
 *
 * Nota sobre URLs:
 * - Si existe <linkvariation>, se usa como URL principal del producto
 * - Si no existe, se usa <link> como fallback
 *
 * Estructura de salida:
 * bedrock-kb/
 *   ├── products/
 *   │   ├── Athena/
 *   │   │   ├── product-000001.json
 *   │   │   └── ...
 *   │   └── Lise-Charmel/
 *   │       ├── product-000001.json
 *   │       └── ...
 *   ├── metadata.json (info general)
 *   └── README.md (instrucciones de upload)
 *
 * Uso:
 * node scripts/prepare-bedrock-kb.js
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

// Cargar .env automáticamente si existe (para credenciales AWS y configuración)
const envFile = path.join(__dirname, '../.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

// ============================================================
// Configuración
// ============================================================

const SOURCE_FILE = path.join(__dirname, '650.ia_agent.xml');
const SOURCE_URL = process.env.BEDROCK_KB_SOURCE_URL
  || 'https://export.shopping-feed.com/stream/31a61e5e6b0f90e67d6caaa3e4b5f187';
const OUTPUT_DIR = path.join(__dirname, '../bedrock-kb');
const PRODUCTS_DIR = path.join(OUTPUT_DIR, 'products');

// S3 sync — sobreescribible por variables de entorno
const S3_BUCKET = process.env.BEDROCK_KB_S3_BUCKET || 'mesdessous-products';
const S3_PREFIX = (process.env.BEDROCK_KB_S3_PREFIX || 'products/').replace(/\/?$/, '/');
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const S3_CONCURRENCY = Math.max(1, parseInt(process.env.BEDROCK_KB_S3_CONCURRENCY || '20', 10));

// ============================================================
// Utilidades
// ============================================================

/**
 * Sanitizar nombre para usar en rutas de carpeta
 */
function sanitizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim() || 'Unknown';
}

/**
 * Limpiar HTML de descripción
 */
function cleanDescription(html, maxLength = 1500) {
  if (!html) return '';

  let text = html.replace(/<[^>]*>/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxLength) {
    text = text.substring(0, maxLength) + '...';
  }

  return text;
}

/**
 * Extraer el nombre limpio del producto separándolo del campo compuesto
 * El campo <name> tiene formato: "Nombre Producto, Talla, Tipo, Marca, Color, Material"
 * Tomamos solo la primera parte (nombre real del producto)
 */
function extractCleanName(rawName) {
  if (!rawName) return '';
  // El nombre viene en formato CSV-like, la primera parte es el nombre real
  const parts = rawName.split(',');
  return parts[0].trim();
}

/**
 * Fix UTF-8 mojibake: some fields in the XML feed are double-encoded
 * (UTF-8 bytes misread as Latin-1, then re-stored as UTF-8).
 * Example: è (C3 A8) → stored as Ã¨ (U+00C3 U+00A8).
 * Example: € (E2 82 AC) → stored as â\x82¬ (U+00E2 U+0082 U+00AC).
 * Fix: re-encode the string as Latin-1 bytes and decode as UTF-8.
 * Guard: if the fix introduces U+FFFD (replacement char) the string was
 * already valid UTF-8 and is returned unchanged.
 */
function fixMojibake(str) {
  if (!str) return str;
  // Any character in U+0080-U+00FF is a potential mojibake signature
  // (UTF-8 lead/continuation bytes misread as Latin-1 code points)
  if (!/[\x80-\xff]/.test(str)) return str;
  try {
    const fixed = Buffer.from(str, 'latin1').toString('utf8');
    return fixed.includes('\uFFFD') ? str : fixed;
  } catch {
    return str;
  }
}

/**
 * Extraer campos CDATA de un bloque XML de producto
 */
function extractCDATA(xmlBlock, tagName) {
  const regex = new RegExp(`<${tagName}><!\\[CDATA\\[([^\\]]*(?:\\][^\\]][^>]*?)*)\\]\\]>`, 'i');
  const match = xmlBlock.match(regex);
  return match ? fixMojibake(match[1].trim()) : '';
}

/**
 * Extraer campos CDATA desconocidos (no están en la lista de campos conocidos).
 * Garantiza que cualquier campo nuevo en el XML quede capturado automáticamente.
 */
function extractExtraFields(xmlBlock, knownTags) {
  const knownSet = new Set(knownTags.map(t => t.toLowerCase()));
  const extra = {};
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9_]*)><!\[CDATA\[/g;
  let match;
  while ((match = tagRegex.exec(xmlBlock)) !== null) {
    const tag = match[1];
    if (!knownSet.has(tag.toLowerCase())) {
      const value = extractCDATA(xmlBlock, tag);
      if (value) extra[tag] = value;
    }
  }
  return extra;
}

// Tags conocidos del feed XML (en su forma original, tal como aparecen en el XML)
const KNOWN_XML_TAGS = [
  'name', 'brand', 'description', 'Couleur', 'autotag_size', 'image1',
  'linkvariation', 'Gamme', 'material', 'Type', 'Forme', 'price',
  'old_price', 'reference', 'link', 'gender',
];

/**
 * Parsear todos los productos del XML.
 * Extrae campos conocidos de forma explícita y captura campos adicionales
 * automáticamente en `extraFields` para no perder datos del feed.
 */
function parseXMLProducts(xmlContent) {
  const blocks = xmlContent.split('<IA>').slice(1);
  const products = [];

  for (const block of blocks) {
    const product = {
      name: extractCDATA(block, 'name'),
      brand: extractCDATA(block, 'brand'),
      description: extractCDATA(block, 'description'),
      color: extractCDATA(block, 'Couleur'),
      size: extractCDATA(block, 'autotag_size'),
      image1: extractCDATA(block, 'image1'),
      linkvariation: extractCDATA(block, 'linkvariation'),
      gamme: extractCDATA(block, 'Gamme'),
      material: extractCDATA(block, 'material'),
      type: extractCDATA(block, 'Type'),
      forme: extractCDATA(block, 'Forme'),
      price: extractCDATA(block, 'price'),
      old_price: extractCDATA(block, 'old_price'),
      reference: extractCDATA(block, 'reference'),
      link: extractCDATA(block, 'link'),
      gender: extractCDATA(block, 'gender'),
    };

    // Capturar automáticamente cualquier campo extra no listado en KNOWN_XML_TAGS
    const extraFields = extractExtraFields(block, KNOWN_XML_TAGS);
    if (Object.keys(extraFields).length > 0) {
      product.extraFields = extraFields;
    }

    products.push(product);
  }

  return products;
}

/**
 * Descargar texto desde URL (soporta redirects simples)
 */
function downloadTextFromUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while downloading XML source'));
      return;
    }

    const client = url.startsWith('https://') ? https : http;
    const request = client.get(url, {
      headers: {
        Accept: 'application/xml,text/xml,*/*',
        'User-Agent': 'datihub-bedrock-kb-script/1.0',
      },
    }, response => {
      const { statusCode = 0, headers } = response;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        resolve(downloadTextFromUrl(headers.location, redirectCount + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Unexpected HTTP status: ${statusCode}`));
        return;
      }

      // Collect raw Buffer chunks and decode once as UTF-8 at the end.
      // Avoids mojibake when multi-byte characters (é, è, à...) split across chunk boundaries.
      const chunks = [];
      response.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });

    request.setTimeout(45000, () => {
      request.destroy(new Error('Timeout while downloading XML source'));
    });

    request.on('error', reject);
  });
}

/**
 * Cargar XML: primero URL remota, si falla usa archivo local
 */
async function loadXmlContent() {
  try {
    console.log('🌐 Descargando XML desde URL...');
    const xmlContent = await downloadTextFromUrl(SOURCE_URL);
    if (!xmlContent || !xmlContent.includes('<IA>')) {
      throw new Error('Downloaded content is empty or invalid XML format');
    }
    console.log('   ✓ XML descargado desde URL\n');
    return { xmlContent, sourceLabel: SOURCE_URL };
  } catch (remoteError) {
    console.warn(`   ⚠ No se pudo descargar desde URL: ${remoteError.message}`);
    console.warn('   ↪ Se intenta usar archivo local en scripts/650.ia_agent.xml');

    if (!fs.existsSync(SOURCE_FILE)) {
      throw new Error(
        `No remote XML available and local file not found at ${SOURCE_FILE}`,
      );
    }

    const xmlContent = fs.readFileSync(SOURCE_FILE, 'utf-8');
    if (!xmlContent || !xmlContent.includes('<IA>')) {
      throw new Error(`Local file at ${SOURCE_FILE} is empty or invalid XML format`);
    }

    console.log('   ✓ XML cargado desde archivo local\n');
    return { xmlContent, sourceLabel: path.basename(SOURCE_FILE) };
  }
}

/**
 * Extraer características del producto desde texto y campos XML
 */
function extractFeatures(product) {
  const text = `${product.name} ${product.description || ''} ${product.material || ''}`.toLowerCase();

  const features = {
    materials: [],
    colors: [],
    styles: [],
  };

  // Si hay material explícito en el XML, usarlo directamente
  if (product.material) {
    features.materials.push(product.material);
  } else {
    // Fallback: detectar materiales del texto
    const materials = [
      'coton', 'soie', 'dentelle', 'satin', 'tulle', 'microfibre',
      'modal', 'elasthanne', 'polyamide', 'polyester', 'viscose', 'laine',
    ];
    materials.forEach(material => {
      if (text.includes(material)) {
        features.materials.push(material);
      }
    });
  }

  // Color: usar campo explícito del XML, o extraer del texto
  if (product.color) {
    features.colors.push(product.color);
  } else {
    const colors = [
      'noir', 'blanc', 'rouge', 'rose', 'bleu', 'vert', 'beige',
      'nude', 'ivoire', 'gris', 'marine', 'bordeaux', 'taupe',
      'corail', 'turquoise', 'violet', 'orange', 'doré', 'argenté',
    ];
    colors.forEach(color => {
      if (text.includes(color)) {
        features.colors.push(color);
      }
    });
  }

  // Estilos
  const styles = [
    'sexy', 'confort', 'sport', 'classique', 'moderne',
    'vintage', 'romantique', 'élégant', 'chic',
  ];
  styles.forEach(style => {
    if (text.includes(style)) {
      features.styles.push(style);
    }
  });

  return features;
}

/**
 * Agrupar productos del XML por referencia base (antes del primer _)
 * para consolidar variaciones (tallas, colores) en un único archivo JSON.
 *
 * Ejemplo: 56860, 56860_1373563, 56860_1373564  →  un solo producto
 * con allSizes: ['T2 ( S )', 'T3 ( M )'], allColors: ['Noir']
 */
function groupProductsByReference(products) {
  const groups = new Map(); // key: "brand|baseRef"

  for (const product of products) {
    const ref = product.reference || '';
    const underscoreIdx = ref.indexOf('_');
    const baseRef = underscoreIdx > -1 ? ref.substring(0, underscoreIdx) : ref;
    const groupKey = `${product.brand || 'Unknown'}|${baseRef || ref}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, { base: null, variations: [] });
    }
    const group = groups.get(groupKey);

    // El producto sin guion bajo es el "padre" (sin talla/color específico)
    if (underscoreIdx === -1) {
      group.base = product;
    } else {
      group.variations.push(product);
    }
  }

  const consolidated = [];
  for (const [, group] of groups) {
    const base = group.base || group.variations[0];
    if (!base) continue;

    const sizes = new Set();
    const colors = new Set();

    if (base.size) sizes.add(base.size);
    if (base.color) colors.add(base.color);

    for (const v of group.variations) {
      if (v.size) sizes.add(v.size);
      if (v.color) colors.add(v.color);
    }

    const totalVariants = (group.base ? 1 : 0) + group.variations.length;

    consolidated.push({
      ...base,
      // URL del producto base (sin sufijo de variación)
      product_url: base.linkvariation || base.link || '',
      // Tallas y colores consolidados de todas las variaciones
      allSizes: [...sizes].filter(Boolean),
      allColors: [...colors].filter(Boolean),
      hasVariations: group.variations.length > 0,
      variationsCount: totalVariants,
    });
  }

  return consolidated;
}

/**
 * Calcular descuento
 */
function calculateDiscount(product) {
  const price = parseFloat(product.price || 0);
  const oldPrice = parseFloat(product.old_price || 0);

  if (!price || !oldPrice || price >= oldPrice) {
    return { hasDiscount: false, savings: 0, percentage: 0 };
  }

  const savings = oldPrice - price;
  const percentage = Math.round((savings / oldPrice) * 100);

  return {
    hasDiscount: true,
    savings: parseFloat(savings.toFixed(2)),
    percentage,
  };
}

/**
 * Clasificar tier de precio
 */
function classifyPriceTier(price) {
  if (price <= 20) return 'budget';
  if (price <= 50) return 'moderate';
  if (price <= 100) return 'premium';
  return 'luxury';
}

/**
 * Construir texto enriquecido para embeddings (campo content)
 */
function buildTextContent(product, features, discount) {
  const parts = [];
  const cleanName = extractCleanName(product.name);

  parts.push(`Produit: ${cleanName}`);
  parts.push(`Marque: ${product.brand || 'Inconnue'}`);

  if (product.gender) {
    const genderLabel = product.gender === 'male' ? 'Homme' :
                        product.gender === 'female' ? 'Femme' : product.gender;
    parts.push(`Genre: ${genderLabel}`);
  }

  if (product.type) {
    parts.push(`Type: ${product.type}`);
  }
  if (product.forme && product.forme !== product.type) {
    parts.push(`Forme: ${product.forme}`);
  }
  if (product.gamme) {
    parts.push(`Collection: ${product.gamme}`);
  }

  // Colores disponibles (consolidado o individual)
  if (product.allColors && product.allColors.length > 0) {
    parts.push(`Couleurs disponibles: ${product.allColors.join(', ')}`);
  } else if (product.color) {
    parts.push(`Couleur: ${product.color}`);
  }
  // Tallas disponibles (consolidado o individual)
  if (product.allSizes && product.allSizes.length > 0) {
    parts.push(`Tailles disponibles: ${product.allSizes.join(', ')}`);
  } else if (product.size) {
    parts.push(`Taille: ${product.size}`);
  }

  // Referencia
  if (product.reference) {
    parts.push(`Référence: ${product.reference}`);
  }

  // Material del XML
  if (product.material) {
    parts.push(`Matières: ${product.material}`);
  } else if (features.materials.length > 0) {
    parts.push(`Matières: ${features.materials.join(', ')}`);
  }

  // Precio con contexto
  if (discount.hasDiscount) {
    parts.push(`Prix: ${product.price}€ (avant ${product.old_price}€) - ${discount.percentage}% de réduction!`);
    parts.push(`Économisez ${discount.savings}€`);
  } else {
    parts.push(`Prix: ${product.price}€`);
  }

  if (features.styles.length > 0) {
    parts.push(`Styles: ${features.styles.join(', ')}`);
  }

  // Descripción limpia
  const cleanDesc = cleanDescription(product.description);
  if (cleanDesc) {
    parts.push(`\nDescription: ${cleanDesc}`);
  }

  // Tier de precio
  const tierDescriptions = {
    budget: 'économique',
    moderate: 'prix moyen',
    premium: 'haut de gamme',
    luxury: 'luxe',
  };
  const priceTier = classifyPriceTier(parseFloat(product.price || 0));
  parts.push(`Segment: ${tierDescriptions[priceTier]}`);

  // URL del producto
  const productUrl = product.product_url || product.linkvariation || product.link;
  if (productUrl) {
    parts.push(`Lien: ${productUrl}`);
  }

  // Campos adicionales del XML (futuros o no mapeados)
  if (product.extraFields && Object.keys(product.extraFields).length > 0) {
    for (const [key, value] of Object.entries(product.extraFields)) {
      if (value) parts.push(`${key}: ${value}`);
    }
  }

  return parts.join('\n');
}

/**
 * Construir el archivo único de producto con metadataAttributes + content
 */
function buildProductFile(product, features, discount) {
  const price = parseFloat(product.price || 0);
  const cleanName = extractCleanName(product.name);

  return {
    metadataAttributes: {
      // Identificación
      product_id: String(product.reference || ''),
      name: cleanName,
      brand: String(product.brand || ''),

      // Clasificación
      type: String(product.type || ''),
      category: String(product.gamme || ''),
      collection: String(product.gamme || ''),
      forme: String(product.forme || ''),
      gender: String(product.gender || ''),

      // Precio
      price: price,
      old_price: parseFloat(product.old_price || price),
      has_discount: discount.hasDiscount,
      discount_percentage: discount.percentage,
      price_tier: classifyPriceTier(price),

      // URLs
      product_url: String(product.product_url || product.linkvariation || product.link || ''),
      image_url: String(product.image1 || ''),

      // Campos del XML (color/size consolidados si hay variaciones)
      color: product.allColors && product.allColors.length > 0 ? product.allColors.join(',') : String(product.color || ''),
      size: product.allSizes && product.allSizes.length > 0 ? product.allSizes.join(',') : String(product.size || ''),
      reference: String(product.reference || ''),
      material: String(product.material || ''),
      variations_count: product.variationsCount || 1,

      // Features extraídas
      colors: product.allColors && product.allColors.length > 0 ? product.allColors.join(',') : (features.colors.join(',') || ''),
      materials: features.materials.join(',') || '',
      styles: features.styles.join(',') || '',

      // Campos adicionales del XML (capturados automáticamente)
      ...(product.extraFields && Object.keys(product.extraFields).length > 0
        ? { extra_attributes: product.extraFields }
        : {}),
    },
    content: buildTextContent(product, features, discount),
  };
}

/**
 * Crear estructura de directorios
 */
function ensureDirectories() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(PRODUCTS_DIR)) {
    fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  }
}

/**
 * Guardar archivo de producto (un solo archivo por producto)
 */
function saveProductFile(productFile, brand, index) {
  const brandDir = path.join(PRODUCTS_DIR, sanitizeName(brand));

  if (!fs.existsSync(brandDir)) {
    fs.mkdirSync(brandDir, { recursive: true });
  }

  const baseName = `product-${String(index).padStart(6, '0')}.json`;
  const filePath = path.join(brandDir, baseName);

  fs.writeFileSync(filePath, JSON.stringify(productFile, null, 2), 'utf-8');

  return filePath;
}

/**
 * Generar metadata general del proyecto
 */
function generateMetadata(products, stats, sourceLabel) {
  return {
    version: '3.0.0',
    format: 'bedrock-kb-single-file',
    source: sourceLabel,
    generated_at: new Date().toISOString(),
    total_products_in_xml: stats.totalInXml,
    total_products_processed: stats.total,
    products_with_variations: stats.withVariations,
    total_brands: stats.brands.size,
    total_types: stats.types.size,

    brands: Array.from(stats.brands).sort(),
    types: Array.from(stats.types).sort(),

    price_ranges: {
      min: stats.minPrice,
      max: stats.maxPrice,
      average: Math.round((stats.totalPrice / stats.total) * 100) / 100,
    },

    discounts: {
      total_with_discount: stats.withDiscount,
      percentage: Math.round((stats.withDiscount / stats.total) * 100),
    },

    new_fields: [
      'color (Couleur) - Color explícito del XML',
      'size (autotag_size) - Talla del producto',
      'reference - Referencia/SKU del producto',
      'material - Composición de materiales',
      'forme - Forma/silueta del producto',
      'gender - Género de la prenda (male/female)',
      'extra_attributes - Campos adicionales del XML capturados automáticamente',
    ],

    file_format: {
      structure: 'Un archivo .json por producto con metadataAttributes + content',
      note: 'Cada archivo contiene toda la información necesaria para Bedrock KB',
    },
  };
}

/**
 * Generar README
 */
function generateReadme(stats) {
  return `# Bedrock Knowledge Base - Productos Messdesous

## 📊 Resumen

- **Total en XML**: ${stats.totalInXml.toLocaleString()}
- **Productos únicos**: ${stats.total.toLocaleString()} (con variaciones consolidadas)
- **Con variaciones**: ${stats.withVariations.toLocaleString()} productos con múltiples tallas/colores
- **Marcas**: ${stats.brands}
- **Tipos**: ${stats.types}
- **Con descuento**: ${stats.withDiscount} (${Math.round((stats.withDiscount / stats.total) * 100)}%)

## 📁 Estructura

\`\`\`
bedrock-kb/
├── products/           # Un archivo JSON por producto, organizado por marca
│   ├── Athena/
│   │   ├── product-000001.json
│   │   └── ...
│   ├── Lise-Charmel/
│   │   ├── product-000001.json
│   │   └── ...
│   └── ...
├── metadata.json       # Información general
└── README.md          # Este archivo
\`\`\`

## 📄 Formato de Archivo de Producto

Cada archivo JSON contiene:

\`\`\`json
{
  "metadataAttributes": {
    "product_id": "11065_384601",
    "name": "Slip fantaisie Lise Charmel Soir de Venise (Noir)",
    "brand": "Lise Charmel",
    "type": "Culotte & Slip",
    "category": "Soir de Venise",
    "collection": "Soir de Venise",
    "forme": "Slip",
    "price": 73,
    "old_price": 73,
    "has_discount": false,
    "discount_percentage": 0,
    "price_tier": "premium",
    "product_url": "https://www.mesdessous.fr/...",
    "image_url": "https://www.mesdessous.fr/...",
    "color": "Noir",
    "size": "FR42 - EU40 - L - T3",
    "reference": "11065_384601",
    "material": "Matières : Polyamide 64% /Elasthanne 15% Coton 12% Polyester 9%",
    "colors": "Noir",
    "materials": "Matières : Polyamide 64% /Elasthanne 15% Coton 12% Polyester 9%",
    "styles": "élégant"
  },
  "content": "Produit: Slip fantaisie Lise Charmel...\\nMarque: Lise Charmel\\n..."
}
\`\`\`

## 🔑 Campos Nuevos (v3.0)

| Campo | Fuente XML | Descripción |
|-------|-----------|-------------|
| color | \`<Couleur>\` | Color explícito del producto |
| size | \`<autotag_size>\` | Talla (FR42 - EU40 - L - T3, etc.) |
| reference | \`<reference>\` | Referencia/SKU del producto |
| material | \`<material>\` | Composición de materiales |
| forme | \`<Forme>\` | Forma/silueta (Slip, Shorty, etc.) |

## 🔗 Manejo de URLs

\`linkvariation\` es opcional:
- Si existe, se usa como URL principal del producto
- Si no existe, se usa el campo \`link\` como fallback

## 🚀 Subir a AWS S3

\`\`\`bash
# Subir productos
aws s3 sync ./bedrock-kb/products/ s3://messdesous-kb-<nombre>/products/ \\
  --storage-class STANDARD_IA

# Verificar
aws s3 ls s3://messdesous-kb-<nombre>/products/ --recursive | wc -l
\`\`\`

## 🔧 Regenerar

\`\`\`bash
node scripts/prepare-bedrock-kb.js
\`\`\`
`;
}

// ============================================================
// S3 Sync
// ============================================================

/**
 * Sync incremental con S3:
 * - Sube solo archivos nuevos o modificados (compara MD5 local vs ETag de S3)
 * - Elimina de S3 los archivos que ya no existen localmente
 */
async function syncToS3() {
  if (!S3_BUCKET) {
    console.log('⏭  S3 sync omitido (define BEDROCK_KB_S3_BUCKET para activarlo)\n');
    return;
  }

  console.log(`\n☁️  Sincronizando con s3://${S3_BUCKET}/${S3_PREFIX}...`);

  const client = new S3Client({ region: S3_REGION });

  // 1. Recopilar archivos locales: s3Key → localPath
  const localFiles = new Map();
  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        walkDir(fullPath);
      } else if (entry.endsWith('.json')) {
        const relative = path.relative(PRODUCTS_DIR, fullPath).replace(/\\/g, '/');
        localFiles.set(`${S3_PREFIX}${relative}`, fullPath);
      }
    }
  }
  walkDir(PRODUCTS_DIR);

  // 2. Listar todos los objetos actuales en S3: s3Key → etag
  console.log('   Listando objetos actuales en S3...');
  const s3Objects = new Map();
  let continuationToken;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: S3_PREFIX,
      ContinuationToken: continuationToken,
    }));
    for (const obj of (response.Contents || [])) {
      s3Objects.set(obj.Key, (obj.ETag || '').replace(/"/g, ''));
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`   Local: ${localFiles.size.toLocaleString()} archivos | S3: ${s3Objects.size.toLocaleString()} objetos`);

  // 3. Comparar: qué subir y qué eliminar
  const toUpload = [];
  const toDelete = [];

  for (const [s3Key, localPath] of localFiles) {
    if (!s3Objects.has(s3Key)) {
      toUpload.push({ s3Key, localPath });
    } else {
      const content = fs.readFileSync(localPath);
      const localMd5 = crypto.createHash('md5').update(content).digest('hex');
      if (localMd5 !== s3Objects.get(s3Key)) {
        toUpload.push({ s3Key, localPath });
      }
    }
  }

  for (const s3Key of s3Objects.keys()) {
    if (!localFiles.has(s3Key)) {
      toDelete.push(s3Key);
    }
  }

  const unchanged = localFiles.size - toUpload.length;
  console.log(`   ⬆️  A subir: ${toUpload.length.toLocaleString()} | 🗑️  A eliminar: ${toDelete.length.toLocaleString()} | ✓ Sin cambios: ${unchanged.toLocaleString()}`);

  // 4. Subir nuevos / modificados
  if (toUpload.length > 0) {
    console.log(`\n   Subiendo ${toUpload.length.toLocaleString()} archivos...`);
    let uploaded = 0, uploadErrors = 0;
    const progressInterval = Math.max(1, Math.floor(toUpload.length / 20));

    for (let i = 0; i < toUpload.length; i += S3_CONCURRENCY) {
      const batch = toUpload.slice(i, i + S3_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(({ s3Key, localPath }) =>
          client.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3Key,
            Body: fs.readFileSync(localPath),
            ContentType: 'application/json',
          }))
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') uploaded++;
        else uploadErrors++;
      }
      const done = Math.min(i + S3_CONCURRENCY, toUpload.length);
      if (done % progressInterval < S3_CONCURRENCY || done === toUpload.length) {
        const pct = Math.round((done / toUpload.length) * 100);
        process.stdout.write(`\r   Progreso upload: ${pct}% (${done.toLocaleString()}/${toUpload.length.toLocaleString()})`);
      }
    }
    console.log(`\n   ✓ ${uploaded.toLocaleString()} subidos${uploadErrors ? `, ⚠ ${uploadErrors} errores` : ''}`);
  } else {
    console.log('   ✓ Nada nuevo que subir.');
  }

  // 5. Eliminar objetos obsoletos (en lotes de 1000, límite de la API)
  if (toDelete.length > 0) {
    console.log(`\n   Eliminando ${toDelete.length.toLocaleString()} archivos obsoletos...`);
    let deleted = 0, deleteErrors = 0;
    for (let i = 0; i < toDelete.length; i += 1000) {
      const batch = toDelete.slice(i, i + 1000);
      try {
        const response = await client.send(new DeleteObjectsCommand({
          Bucket: S3_BUCKET,
          Delete: { Objects: batch.map(Key => ({ Key })), Quiet: false },
        }));
        deleted += (response.Deleted || []).length;
        deleteErrors += (response.Errors || []).length;
      } catch {
        deleteErrors += batch.length;
      }
    }
    console.log(`   ✓ ${deleted.toLocaleString()} eliminados${deleteErrors ? `, ⚠ ${deleteErrors} errores` : ''}`);
  } else {
    console.log('   ✓ No hay archivos obsoletos que eliminar.');
  }

  console.log(`\n   📍 s3://${S3_BUCKET}/${S3_PREFIX}\n`);
}

// ============================================================
// Procesamiento Principal
// ============================================================

async function main() {
  console.log('🚀 Preparando productos para Bedrock Knowledge Base (desde XML)...\n');

  // Cargar y parsear XML
  console.log('📖 Cargando XML...');
  const { xmlContent, sourceLabel } = await loadXmlContent();
  const allProducts = parseXMLProducts(xmlContent);
  console.log(`   Fuente usada: ${sourceLabel}`);
  console.log(`   ✓ ${allProducts.length.toLocaleString()} productos parseados del XML\n`);

  // Consolidar variaciones del mismo producto por referencia base
  console.log('🧾 Consolidando variaciones de productos...');
  const products = groupProductsByReference(allProducts);
  const withVariations = products.filter(p => p.hasVariations).length;
  console.log(`   ✓ ${allProducts.length.toLocaleString()} registros en XML → ${products.length.toLocaleString()} productos únicos consolidados`);
  console.log(`   ℹ ${withVariations.toLocaleString()} productos con variaciones de talla/color consolidadas\n`);

  // Crear estructura
  console.log('📁 Limpiando y creando estructura de directorios...');

  // Limpiar carpeta products/ si existe
  if (fs.existsSync(PRODUCTS_DIR)) {
    fs.rmSync(PRODUCTS_DIR, { recursive: true, force: true });
  }
  ensureDirectories();
  console.log(`   ✓ Directorios creados\n`);

  // Estadísticas
  const stats = {
    totalInXml: allProducts.length,
    total: products.length,
    brands: new Set(),
    types: new Set(),
    withDiscount: 0,
    minPrice: Infinity,
    maxPrice: 0,
    totalPrice: 0,
    filesCreated: 0,
    withVariations: 0,
    withMaterial: 0,
    withColor: 0,
    withSize: 0,
  };

  // Contadores por marca para nombres de archivo
  const brandCounters = {};

  // Procesar productos
  console.log('🔄 Procesando productos...');
  const progressInterval = Math.max(1, Math.floor(products.length / 20));

  for (let i = 0; i < products.length; i++) {
    const product = products[i];

    // Extraer features y calcular descuento
    const features = extractFeatures(product);
    const discount = calculateDiscount(product);

    // Construir archivo de producto (metadataAttributes + content)
    const productFile = buildProductFile(product, features, discount);

    // Actualizar stats
    const brand = product.brand || 'Unknown';
    stats.brands.add(brand);
    stats.types.add(product.type || 'Unknown');

    if (discount.hasDiscount) stats.withDiscount++;
    if (product.hasVariations) stats.withVariations++;
    if (product.material) stats.withMaterial++;
    if (product.allColors && product.allColors.length > 0) stats.withColor++;
    if (product.allSizes && product.allSizes.length > 0) stats.withSize++;

    const price = parseFloat(product.price || 0);
    stats.minPrice = Math.min(stats.minPrice, price);
    stats.maxPrice = Math.max(stats.maxPrice, price);
    stats.totalPrice += price;

    // Contador por marca
    if (!brandCounters[brand]) brandCounters[brand] = 0;
    brandCounters[brand]++;

    // Guardar archivo único de producto
    saveProductFile(productFile, brand, brandCounters[brand]);
    stats.filesCreated++;

    // Mostrar progreso
    if ((i + 1) % progressInterval === 0 || i === products.length - 1) {
      const percentage = Math.round(((i + 1) / products.length) * 100);
      process.stdout.write(`\r   Progreso: ${percentage}% (${(i + 1).toLocaleString()}/${products.length.toLocaleString()})`);
    }
  }

  console.log('\n   ✓ Archivos de producto creados\n');

  // Generar metadata
  console.log('📊 Generando metadata...');
  const metadata = generateMetadata(products, stats, sourceLabel);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8'
  );
  console.log('   ✓ metadata.json creado\n');

  // Generar README
  console.log('📝 Generando README...');
  const readmeStats = {
    totalInXml: stats.totalInXml,
    total: stats.total,
    withVariations: stats.withVariations,
    brands: stats.brands.size,
    types: stats.types.size,
    withDiscount: stats.withDiscount,
  };
  const readme = generateReadme(readmeStats);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'README.md'),
    readme,
    'utf-8'
  );
  console.log('   ✓ README.md creado\n');

  // Resumen final
  console.log('✅ ¡Completado!\n');
  console.log('📊 Estadísticas:');
  console.log(`   Total en XML:           ${stats.totalInXml.toLocaleString()}`);
  console.log(`   Productos procesados:   ${stats.total.toLocaleString()}`);
  console.log(`   Con variaciones:        ${stats.withVariations.toLocaleString()} productos consolidados`);
  console.log(`   Archivos creados:       ${stats.filesCreated.toLocaleString()}`);
  console.log(`   Marcas únicas:          ${stats.brands.size}`);
  console.log(`   Tipos únicos:           ${stats.types.size}`);
  console.log(`   Con descuento:          ${stats.withDiscount.toLocaleString()} (${Math.round((stats.withDiscount / stats.total) * 100)}%)`);
  console.log(`   Con material:           ${stats.withMaterial.toLocaleString()} (${Math.round((stats.withMaterial / stats.total) * 100)}%)`);
  console.log(`   Con color:              ${stats.withColor.toLocaleString()} (${Math.round((stats.withColor / stats.total) * 100)}%)`);
  console.log(`   Con talla:              ${stats.withSize.toLocaleString()} (${Math.round((stats.withSize / stats.total) * 100)}%)`);
  console.log(`   Rango de precios:       ${stats.minPrice}€ - ${stats.maxPrice}€`);
  console.log(`   Precio promedio:        ${Math.round((stats.totalPrice / stats.total) * 100) / 100}€\n`);

  console.log('📁 Archivos generados en:', OUTPUT_DIR);
  console.log(`\n📂 Marcas (${stats.brands.size}):`);
  const sortedBrands = Array.from(stats.brands).sort();
  for (const brand of sortedBrands) {
    console.log(`   - ${brand}: ${brandCounters[brand]} productos`);
  }

  // Sync a S3 (si BEDROCK_KB_S3_BUCKET está definido)
  await syncToS3();

  console.log('\n📚 Siguiente paso:');
  if (S3_BUCKET) {
    console.log('   1. Revisa bedrock-kb/README.md para instrucciones completas');
    console.log('   2. Configura Bedrock Knowledge Base apuntando a s3://' + S3_BUCKET + '/' + S3_PREFIX);
    console.log('      (Data source type: S3, path: s3://' + S3_BUCKET + '/' + S3_PREFIX + ')\n');
  } else {
    console.log('   1. Define BEDROCK_KB_S3_BUCKET=<nombre-bucket> y vuelve a ejecutar para subir a S3');
    console.log('      BEDROCK_KB_S3_BUCKET=mi-bucket node scripts/prepare-bedrock-kb.js');
    console.log('   2. O usa AWS CLI: aws s3 sync ./bedrock-kb/products/ s3://<bucket>/products/');
    console.log('   3. Configura Bedrock Knowledge Base\n');
  }
}

// Ejecutar
main().catch(error => {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
