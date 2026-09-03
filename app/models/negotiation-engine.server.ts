import prisma from "../db.server";

// Minimal structural type for the admin GraphQL client - avoids depending
// on an exact exported type name from the Shopify package, since only
// .graphql() is actually used here.
type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type ProductCollectionsResponse = {
  data: {
    product: { collections: { nodes: { id: string }[] } } | null;
  };
};

// Live membership check - collection membership isn't mirrored in our own
// DB, only the rule's collectionId is stored (see the schema comment on
// NegotiationRule). A product rarely belongs to more than a handful of
// collections, so `first: 50` comfortably covers real-world cases without
// pagination.
async function getProductCollectionIds(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<Set<string>> {
  const response = await admin.graphql(
    `#graphql
    query ProductCollections($id: ID!) {
      product(id: $id) {
        collections(first: 50) {
          nodes {
            id
          }
        }
      }
    }`,
    { variables: { id: productId } },
  );
  const json = (await response.json()) as ProductCollectionsResponse;
  return new Set(
    (json.data.product?.collections.nodes ?? []).map((c) => c.id),
  );
}

// Finds every NegotiationRule that covers this product, then picks the
// winner per the merchant's own overlap rule: highest maxDiscountPercent
// wins (a rule with no cap set can't win - same "no cap configured
// anywhere means this product can't go live" principle as before, just
// applied per-rule instead of per-shop-singleton now). Returns null when
// nothing matches or no candidate has a usable cap.
//
// No longer depends on defaultLadder/Ladder at all - the counter-offer
// progression now comes from the fixed customer-segment tier tables in
// negotiation-tiers.server.ts, not a merchant-configured ladder. A rule only
// needs maxDiscountPercent set to be usable.
export async function resolveEffectiveLimits(
  admin: AdminGraphqlClient,
  shopId: string,
  productId: string,
) {
  const rules = await prisma.negotiationRule.findMany({ where: { shopId } });
  if (rules.length === 0) return null;

  const candidates = rules.filter((rule) => {
    if (rule.scopeType === "ALL_PRODUCTS") return true;
    if (rule.scopeType === "PRODUCT_GROUP") {
      return rule.productIds.includes(productId);
    }
    return false; // COLLECTION handled separately below - needs a live API call
  });

  const collectionRules = rules.filter(
    (rule) => rule.scopeType === "COLLECTION" && rule.collectionId,
  );
  if (collectionRules.length > 0) {
    const productCollectionIds = await getProductCollectionIds(admin, productId);
    for (const rule of collectionRules) {
      if (rule.collectionId && productCollectionIds.has(rule.collectionId)) {
        candidates.push(rule);
      }
    }
  }

  const usable = candidates.filter((rule) => rule.maxDiscountPercent !== null);
  if (usable.length === 0) return null;

  usable.sort(
    (a, b) => Number(b.maxDiscountPercent) - Number(a.maxDiscountPercent),
  );
  const rule = usable[0];

  return {
    rule,
    maxDiscountPercent: Number(rule.maxDiscountPercent),
    floorPriceOverride: rule.floorPriceOverride
      ? Number(rule.floorPriceOverride)
      : null,
  };
}

// Fixed-window rate limiting backed by Postgres (no Redis - consistent with
// the "one deployable app" call). windowMs truncation means every call
// within the same window shares one counter row; a new window starts a
// fresh row automatically via upsert.
export async function checkRateLimit(
  shopId: string,
  key: string,
  { max, windowMs }: { max: number; windowMs: number },
) {
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

  const bucket = await prisma.rateLimitBucket.upsert({
    where: { shopId_key_windowStart: { shopId, key, windowStart } },
    create: { shopId, key, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  return bucket.count <= max;
}

// The counter-offer decision itself now lives in
// negotiation-tiers.server.ts (evaluateSegmentedOffer) - it needs the
// customer's assigned segment, which this module has no reason to know
// about, so it isn't re-exported from here. See that module's comments for
// the full segment/tier design.

type DraftOrderCreateResponse = {
  data: {
    draftOrderCreate: {
      draftOrder: { id: string; invoiceUrl: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  };
};

// Takes an already-resolved variantId rather than a productId - the variant
// (like currencyCode) is resolved once at session-start time and cached on
// NegotiationSession, specifically so accepting doesn't add its own extra
// Admin API round-trip on top of the one draftOrderCreate call already
// needs. See the schema comment on NegotiationSession.currencyCode for why
// that matters (this was the actual cause of accept intermittently timing
// out through the app-proxy layer).
//
// v1 limitation, stated plainly: negotiation is product-level, not
// variant-level (matches ProductSettings/NegotiationSession), so the
// variant baked into the session is always the product's FIRST one, not
// whichever the visitor actually wants on a multi-variant product. Real
// gap, not silently "handled" - flagging it here rather than pretending
// otherwise.
export async function createNegotiatedDraftOrder(
  admin: AdminGraphqlClient,
  variantId: string,
  acceptedPrice: number,
  currencyCode: string,
  sessionId: string,
) {
  const draftOrderResponse = await admin.graphql(
    `#graphql
    mutation NegotiatedDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          lineItems: [
            {
              variantId,
              quantity: 1,
              priceOverride: {
                amount: acceptedPrice.toFixed(2),
                currencyCode,
              },
            },
          ],
          note: `Negotiated via Scopegen Negotiator - session ${sessionId}`,
        },
      },
    },
  );
  const draftOrderJson =
    (await draftOrderResponse.json()) as DraftOrderCreateResponse;

  if (draftOrderJson.data.draftOrderCreate.userErrors.length > 0) {
    throw new Error(
      draftOrderJson.data.draftOrderCreate.userErrors
        .map((e) => e.message)
        .join("; "),
    );
  }

  const draftOrder = draftOrderJson.data.draftOrderCreate.draftOrder;
  if (!draftOrder) {
    throw new Error("draftOrderCreate returned no draft order");
  }

  return draftOrder;
}

// Visitor identifier for rate limiting. Confirmed against Shopify's app
// proxy docs: every proxied request carries "X-Forwarded-For: The client IP
// address" - not a guess. Falls back to a shared "unknown" bucket rather
// than skipping the check entirely if the header is somehow missing.
export function getRateLimitKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim();
  return ip || "unknown";
}
