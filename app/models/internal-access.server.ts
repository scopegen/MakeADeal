// Access control for the internal (Scopegen-only) stats pages under
// /app/internal. Those pages show EVERY merchant's store domain, products,
// and prices, so they must never be reachable by an ordinary merchant.
//
// Access rides on Shopify's own login: these pages live inside the embedded
// app, so the request is already authenticated as a specific shop by
// authenticate.admin(). The only extra rule is that the shop must be one of
// ours. Nothing new to secure, no separate password or key.
//
// Every internal route must call requireInternalShop() itself in its loader.
// Hiding the nav link is only cosmetic and is not access control.
//
// The list comes from INTERNAL_SHOP_DOMAINS (comma-separated) if that env var
// is set, otherwise falls back to the default below. A store domain is not a
// secret, and getting in still needs a staff login on that store.

const DEFAULT_INTERNAL_SHOPS = ["sg-noida.myshopify.com"];

export function getInternalShops(): string[] {
  const raw = process.env.INTERNAL_SHOP_DOMAINS;
  const list = raw ? raw.split(",") : DEFAULT_INTERNAL_SHOPS;
  return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isInternalShop(shopDomain: string): boolean {
  return getInternalShops().includes(shopDomain.trim().toLowerCase());
}

// Throws a plain 404 rather than a 403 so the existence of these pages isn't
// confirmed to a merchant who guesses the address.
export function requireInternalShop(shopDomain: string): void {
  if (!isInternalShop(shopDomain)) {
    throw new Response("Not found", { status: 404 });
  }
}
