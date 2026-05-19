import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  // Ver formato real de sizes en soutien-gorge
  const sizes = await prisma.$queryRaw<{ sizes: string }[]>`
    SELECT DISTINCT sizes FROM products 
    WHERE client_id = 'mesdessous' AND active = true 
    AND LOWER(type) LIKE '%soutien%'
    AND sizes IS NOT NULL
    LIMIT 10
  `;
  console.log("=== Formato de sizes en BD ===");
  sizes.forEach(r => console.log(JSON.stringify(r.sizes)));

  // Probar el regex actual con 95C
  const regexTest = await prisma.$queryRaw<{ sizes: string; match: boolean }[]>`
    SELECT sizes, sizes ~* '(^|[,\\s])95C([,\\s]|$)' as match
    FROM products 
    WHERE client_id = 'mesdessous' AND active = true 
    AND LOWER(type) LIKE '%soutien%'
    AND sizes IS NOT NULL
    LIMIT 10
  `;
  console.log("\n=== Test regex '95C' ===");
  regexTest.forEach(r => console.log(`match=${r.match} | sizes=${r.sizes}`));

  // Ver topics disponibles en store_policies
  const topics = await prisma.$queryRaw<{ topic: string }[]>`
    SELECT topic FROM store_policies WHERE client_id = 'mesdessous'
  `;
  console.log("\n=== Topics en store_policies ===");
  topics.forEach(r => console.log(r.topic));

  await prisma.$disconnect();
}

main().catch(console.error);
