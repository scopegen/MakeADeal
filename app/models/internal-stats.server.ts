import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  classifyDraftOrder,
  salesByWindow,
  type ConversionState,
  type SalesWindows,
} from "./draft-conversion";
import {
  lookupDraftOrderStates as lookupDraftOrderStatesWithClient,
  type AdminGraphqlClient,
  type DraftStatesResult,
} from "./draft-order-lookup.server";

// Read-only queries behind the internal stats pages (/app/internal). Only
// ever called from routes that have already passed requireInternalShop().
//
// Deliberately never selects customerId, anonymousId, or any message text:
// these pages show merchant business data (store, product, prices, counts),
// not anything about individual shoppers.
//
// Numbers come from live NegotiationSession rows. Sessions currently never
// get purged, so these are effectively all-time totals today; once the 30-day
// purge exists they will only cover the last 30 days.

const SHOP_NAME_TIMEOUT_MS = 5000;
const SHOP_NAME_CONCURRENCY = 10;

// A store's display name isn't stored anywhere (only its domain is), so it's
// read live from the store through its saved offline token. Never throws:
// any failure (uninstalled, token gone, Shopify slow or down) returns null and
// the pages fall back to showing the domain. No permission needed beyond what
// the app already has.
async function lookupShopName(shopDomain: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out")),
      SHOP_NAME_TIMEOUT_MS,
    );
  });
  try {
    const { admin } = (await unauthenticated.admin(shopDomain)) as {
      admin: AdminGraphqlClient;
    };
    const response = await Promise.race([
      admin.graphql(`#graphql
        query InternalShopName {
          shop {
            name
          }
        }`),
      timeout,
    ]);
    const json = (await response.json()) as {
      data?: { shop?: { name?: string } };
    };
    return json.data?.shop?.name?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Looks names up a few stores at a time, so a long list of stores neither
// runs one after another nor fires them all at once.
async function lookupShopNames(
  shopDomains: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < shopDomains.length; i += SHOP_NAME_CONCURRENCY) {
    const batch = shopDomains.slice(i, i + SHOP_NAME_CONCURRENCY);
    const results = await Promise.all(batch.map(lookupShopName));
    batch.forEach((domain, index) => {
      const name = results[index];
      if (name) names.set(domain, name);
    });
  }
  return names;
}

export type StoreOverviewRow = {
  shopId: string;
  shopDomain: string;
  // The store's own name, or null if it couldn't be read (the pages then show
  // the domain instead).
  shopName: string | null;
  installedAt: Date;
  uninstalledAt: Date | null;
  total: number;
  accepted: number;
  declined: number;
  active: number;
  expired: number;
  lastNegotiationAt: Date | null;
};

export async function getStoreOverview(): Promise<StoreOverviewRow[]> {
  const [shops, byStatus, lastActivity] = await Promise.all([
    prisma.shop.findMany({
      select: {
        id: true,
        shopDomain: true,
        installedAt: true,
        uninstalledAt: true,
      },
    }),
    prisma.negotiationSession.groupBy({
      by: ["shopId", "status"],
      _count: { _all: true },
    }),
    prisma.negotiationSession.groupBy({
      by: ["shopId"],
      _max: { createdAt: true },
    }),
  ]);

  const countsByShop = new Map<string, Record<string, number>>();
  for (const row of byStatus) {
    const counts = countsByShop.get(row.shopId) ?? {};
    counts[row.status] = row._count._all;
    countsByShop.set(row.shopId, counts);
  }
  const lastByShop = new Map<string, Date | null>();
  for (const row of lastActivity) {
    lastByShop.set(row.shopId, row._max.createdAt);
  }

  // Uninstalled stores have no usable token any more, so don't bother asking
  // them for a name. They just show their domain.
  const names = await lookupShopNames(
    shops.filter((s) => !s.uninstalledAt).map((s) => s.shopDomain),
  );

  return shops
    .map((shop) => {
      const counts = countsByShop.get(shop.id) ?? {};
      const accepted = counts.ACCEPTED ?? 0;
      const declined = counts.DECLINED ?? 0;
      const active = counts.ACTIVE ?? 0;
      const expired = counts.EXPIRED ?? 0;
      return {
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        shopName: names.get(shop.shopDomain) ?? null,
        installedAt: shop.installedAt,
        uninstalledAt: shop.uninstalledAt,
        total: accepted + declined + active + expired,
        accepted,
        declined,
        active,
        expired,
        lastNegotiationAt: lastByShop.get(shop.id) ?? null,
      };
    })
    .sort((a, b) => b.total - a.total);
}

export type ProductStatsRow = {
  productId: string;
  title: string;
  total: number;
  accepted: number;
  declined: number;
  active: number;
  expired: number;
  avgStartingPrice: number | null;
  avgAcceptedPrice: number | null;
  avgDiscountPercent: number | null;
  // Accepted negotiations on this product whose draft order completed and
  // carries the Noodle tag, and what they were worth at the accepted price.
  converted: number;
  convertedValue: number;
};

export type SessionRow = {
  id: string;
  productTitle: string;
  status: string;
  segment: string | null;
  rounds: number;
  startingPrice: number;
  finalPrice: number | null;
  discountPercent: number | null;
  // Only set for ACCEPTED negotiations that were part of the conversion
  // lookup, null for everything else.
  conversion: ConversionState | null;
  createdAt: Date;
};

// How the draft orders behind accepted negotiations turned out.
export type ConversionSummary = {
  // Accepted negotiations that were checked against Shopify, and how many
  // accepted negotiations exist in total (differs if the lookup was capped).
  checked: number;
  acceptedTotal: number;
  converted: number;
  completedUntagged: number;
  open: number;
  invoiceSent: number;
  notFound: number;
  other: number;
  // Sum of accepted prices for converted orders (one unit each, excluding
  // tax and shipping).
  convertedValue: number;
};

export type StoreDetail = {
  shop: {
    id: string;
    shopDomain: string;
    // The store's own name, or null if it couldn't be read.
    name: string | null;
    installedAt: Date;
    uninstalledAt: Date | null;
  };
  currency: string;
  totals: {
    total: number;
    accepted: number;
    declined: number;
    active: number;
    expired: number;
    avgDiscountPercent: number | null;
  };
  products: ProductStatsRow[];
  sessions: SessionRow[];
  productNamesError: string | null;
  conversion: ConversionSummary;
  // Converted sales over rolling and calendar windows, dated by when the
  // order was completed. See salesByWindow.
  sales: SalesWindows;
  conversionError: string | null;
};

type ProductAggRow = {
  productId: string;
  total: number;
  accepted: number;
  declined: number;
  active: number;
  expired: number;
  avg_starting: number | null;
  avg_accepted: number | null;
  avg_discount_pct: number | null;
};

// How many recent negotiations to list per store, and how many distinct
// products to look names up for. Bounds both the page size and the number of
// Shopify API calls when a store has a very large history.
const RECENT_SESSIONS_LIMIT = 100;
const PRODUCT_TITLE_LOOKUP_LIMIT = 500;

type ProductTitleResult = {
  titles: Map<string, string>;
  error: string | null;
};

// Product titles aren't stored anywhere (only the Shopify product id is), so
// they're looked up live from the store through its saved offline token,
// batched 100 at a time. A deleted product, or a store whose token no longer
// works (e.g. uninstalled), just falls back to showing the raw id.
async function lookupProductTitles(
  shopDomain: string,
  productIds: string[],
): Promise<ProductTitleResult> {
  const titles = new Map<string, string>();
  if (productIds.length === 0) return { titles, error: null };

  try {
    const { admin } = (await unauthenticated.admin(shopDomain)) as {
      admin: AdminGraphqlClient;
    };
    for (let i = 0; i < productIds.length; i += 100) {
      const response = await admin.graphql(
        `#graphql
        query InternalProductTitles($ids: [ID!]!) {
          nodes(ids: $ids) {
            id
            ... on Product {
              title
            }
          }
        }`,
        { variables: { ids: productIds.slice(i, i + 100) } },
      );
      const json = (await response.json()) as {
        data?: { nodes: ({ id: string; title?: string } | null)[] };
        errors?: { message: string }[];
      };
      if (!json.data) {
        throw new Error(
          json.errors?.map((e) => e.message).join("; ") ?? "no data returned",
        );
      }
      for (const node of json.data.nodes) {
        if (node && typeof node.title === "string") {
          titles.set(node.id, node.title);
        }
      }
    }
    return { titles, error: null };
  } catch (err) {
    return {
      titles,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// How many of the most recent accepted negotiations to check against
// Shopify for conversion. Bounds the number of API calls (100 per call) for a
// store with a very large history. Older accepted deals are left unchecked and
// the page says so.
const CONVERSION_LOOKUP_LIMIT = 500;

// Thin wrapper: gets this store's own admin client (this page works across
// arbitrary shops via their saved offline tokens, unlike the merchant-facing
// Negotiations page, which already has its own authenticated client), then
// delegates to the actual lookup logic shared with that page.
async function lookupDraftOrderStates(
  shopDomain: string,
  draftOrderIds: string[],
): Promise<DraftStatesResult> {
  if (draftOrderIds.length === 0) return { states: new Map(), error: null };
  const { admin } = (await unauthenticated.admin(shopDomain)) as {
    admin: AdminGraphqlClient;
  };
  return lookupDraftOrderStatesWithClient(admin, draftOrderIds);
}

export async function getStoreDetail(
  shopId: string,
): Promise<StoreDetail | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      shopDomain: true,
      installedAt: true,
      uninstalledAt: true,
    },
  });
  if (!shop) return null;

  // One grouped query for the whole per-product table. Counts are cast to
  // int and averages to float8 so they come back as plain JS numbers (raw
  // queries otherwise return BigInt / Decimal objects).
  const aggRows = await prisma.$queryRaw<ProductAggRow[]>`
    SELECT
      "productId",
      COUNT(*)::int AS total,
      (COUNT(*) FILTER (WHERE status = 'ACCEPTED'))::int AS accepted,
      (COUNT(*) FILTER (WHERE status = 'DECLINED'))::int AS declined,
      (COUNT(*) FILTER (WHERE status = 'ACTIVE'))::int AS active,
      (COUNT(*) FILTER (WHERE status = 'EXPIRED'))::int AS expired,
      (AVG("startingPrice"))::float8 AS avg_starting,
      (AVG("currentOfferPrice") FILTER (WHERE status = 'ACCEPTED'))::float8 AS avg_accepted,
      (AVG(("startingPrice" - "currentOfferPrice") / NULLIF("startingPrice", 0) * 100)
        FILTER (WHERE status = 'ACCEPTED'))::float8 AS avg_discount_pct
    FROM "NegotiationSession"
    WHERE "shopId" = ${shopId}
    GROUP BY "productId"
    ORDER BY total DESC
  `;

  const recentSessions = await prisma.negotiationSession.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: RECENT_SESSIONS_LIMIT,
    select: {
      id: true,
      productId: true,
      status: true,
      segment: true,
      currentRound: true,
      startingPrice: true,
      currentOfferPrice: true,
      currencyCode: true,
      draftOrderId: true,
      createdAt: true,
    },
  });

  // Not asked for an uninstalled store: its token is gone.
  const shopName = shop.uninstalledAt
    ? null
    : await lookupShopName(shop.shopDomain);

  const { titles, error: productNamesError } = await lookupProductTitles(
    shop.shopDomain,
    aggRows.slice(0, PRODUCT_TITLE_LOOKUP_LIMIT).map((r) => r.productId),
  );
  const titleOf = (productId: string) => titles.get(productId) ?? productId;

  // Conversion: for accepted negotiations that created a draft order, ask
  // Shopify what became of that draft order. Most recent first, capped.
  const acceptedSessions = await prisma.negotiationSession.findMany({
    where: { shopId, status: "ACCEPTED", draftOrderId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: CONVERSION_LOOKUP_LIMIT,
    select: { productId: true, draftOrderId: true, currentOfferPrice: true },
  });
  const { states: draftStates, error: conversionError } =
    await lookupDraftOrderStates(
      shop.shopDomain,
      acceptedSessions.map((s) => s.draftOrderId as string),
    );

  const conversion: ConversionSummary = {
    checked: 0,
    acceptedTotal: 0, // filled in below from the per-product totals
    converted: 0,
    completedUntagged: 0,
    open: 0,
    invoiceSent: 0,
    notFound: 0,
    other: 0,
    convertedValue: 0,
  };
  const convertedByProduct = new Map<
    string,
    { count: number; value: number }
  >();
  const sales: { completedAt: Date | null; value: number }[] = [];
  // Only count sessions the lookup actually returned an answer for. If the
  // whole lookup failed, states is empty and nothing is counted, so a failure
  // shows as an error banner, never as a wall of "not converted".
  for (const s of acceptedSessions) {
    const draftId = s.draftOrderId as string;
    if (!draftStates.has(draftId)) continue;
    conversion.checked++;
    const state = classifyDraftOrder(draftStates.get(draftId));
    if (state === "converted") {
      const value =
        s.currentOfferPrice === null ? 0 : Number(s.currentOfferPrice);
      conversion.converted++;
      conversion.convertedValue += value;
      const perProduct = convertedByProduct.get(s.productId) ?? {
        count: 0,
        value: 0,
      };
      perProduct.count++;
      perProduct.value += value;
      convertedByProduct.set(s.productId, perProduct);
      sales.push({
        completedAt: draftStates.get(draftId)?.completedAt ?? null,
        value,
      });
    } else if (state === "completed_untagged") conversion.completedUntagged++;
    else if (state === "open") conversion.open++;
    else if (state === "invoice_sent") conversion.invoiceSent++;
    else if (state === "not_found") conversion.notFound++;
    else conversion.other++;
  }
  conversion.convertedValue = Math.round(conversion.convertedValue * 100) / 100;

  let total = 0;
  let accepted = 0;
  let declined = 0;
  let active = 0;
  let expired = 0;
  let discountWeighted = 0;
  let discountWeight = 0;
  for (const r of aggRows) {
    total += r.total;
    accepted += r.accepted;
    declined += r.declined;
    active += r.active;
    expired += r.expired;
    // Weighted by accepted deals so a product with one accepted deal doesn't
    // count the same as a product with fifty.
    if (r.avg_discount_pct !== null && r.accepted > 0) {
      discountWeighted += r.avg_discount_pct * r.accepted;
      discountWeight += r.accepted;
    }
  }
  conversion.acceptedTotal = accepted;

  return {
    shop: { ...shop, name: shopName },
    currency: recentSessions.find((s) => s.currencyCode)?.currencyCode ?? "",
    totals: {
      total,
      accepted,
      declined,
      active,
      expired,
      avgDiscountPercent:
        discountWeight > 0 ? discountWeighted / discountWeight : null,
    },
    products: aggRows.map((r) => ({
      productId: r.productId,
      title: titleOf(r.productId),
      total: r.total,
      accepted: r.accepted,
      declined: r.declined,
      active: r.active,
      expired: r.expired,
      avgStartingPrice: r.avg_starting,
      avgAcceptedPrice: r.avg_accepted,
      avgDiscountPercent: r.avg_discount_pct,
      converted: convertedByProduct.get(r.productId)?.count ?? 0,
      convertedValue:
        Math.round((convertedByProduct.get(r.productId)?.value ?? 0) * 100) /
        100,
    })),
    sessions: recentSessions.map((s) => {
      // Prisma Decimal values must be turned into plain numbers on the
      // server, they don't survive the client data transport as Decimals.
      const startingPrice = Number(s.startingPrice);
      const finalPrice =
        s.currentOfferPrice === null ? null : Number(s.currentOfferPrice);
      return {
        id: s.id,
        productTitle: titleOf(s.productId),
        status: s.status,
        segment: s.segment,
        rounds: s.currentRound,
        startingPrice,
        finalPrice,
        discountPercent:
          s.status === "ACCEPTED" && finalPrice !== null && startingPrice > 0
            ? ((startingPrice - finalPrice) / startingPrice) * 100
            : null,
        // Only for accepted negotiations the conversion lookup covered.
        conversion:
          s.status === "ACCEPTED" &&
          s.draftOrderId &&
          draftStates.has(s.draftOrderId)
            ? classifyDraftOrder(draftStates.get(s.draftOrderId))
            : null,
        createdAt: s.createdAt,
      };
    }),
    productNamesError,
    conversion,
    sales: salesByWindow(sales),
    conversionError,
  };
}
