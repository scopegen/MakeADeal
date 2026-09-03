import prisma from "../db.server";

export async function getShopByDomain(shopDomain: string) {
  return prisma.shop.findUniqueOrThrow({ where: { shopDomain } });
}
