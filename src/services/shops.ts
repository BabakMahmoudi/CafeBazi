import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { coffeeShops } from "@/db/schema";

export async function listActiveShops() {
  return db
    .select()
    .from(coffeeShops)
    .where(eq(coffeeShops.isActive, true))
    .orderBy(asc(coffeeShops.name));
}

export async function getActiveShopById(shopId: string) {
  const rows = await db
    .select()
    .from(coffeeShops)
    .where(and(eq(coffeeShops.id, shopId), eq(coffeeShops.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActiveShopBySlug(slug: string) {
  const rows = await db
    .select()
    .from(coffeeShops)
    .where(and(eq(coffeeShops.slug, slug), eq(coffeeShops.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}
