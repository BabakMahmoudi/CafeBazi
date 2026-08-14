import "dotenv/config";
import { db } from "@/db";
import { coffeeShops, users } from "@/db/schema";

const ADMIN_TELEGRAM_ID = process.env.SEED_ADMIN_TELEGRAM_ID ?? "0";

async function main() {
  const [admin] = await db
    .insert(users)
    .values({
      telegramId: ADMIN_TELEGRAM_ID,
      telegramUsername: "admin",
      firstName: "مدیر",
      role: "admin",
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: { role: "admin", updatedAt: new Date() },
    })
    .returning();

  const shops = [
    { slug: "1", name: "کافه بازی مرکزی", address: "فراهان، خیابان امام" },
    { slug: "2", name: "کافه بازی باغچه", address: "فراهان، میدان اصلی" },
  ];

  for (const shop of shops) {
    await db
      .insert(coffeeShops)
      .values({
        merchantId: admin.id,
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: coffeeShops.slug,
        set: { name: shop.name, address: shop.address, isActive: true },
      });
  }

  console.log(`Seeded admin user (telegram_id=${ADMIN_TELEGRAM_ID}) and ${shops.length} active shops.`);
  console.log("QR slugs: s1 (table s1t2), s2");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
