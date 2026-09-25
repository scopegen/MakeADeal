import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShopByDomain } from "../models/negotiation-settings.server";
import {
  checkRateLimit,
  getRateLimitKey,
  resolveEffectiveLimits,
} from "../models/negotiation-engine.server";
import { getRateLimitedMessage } from "../models/negotiation-copy.server";
import { getGreetingMessage } from "../models/negotiation-tiers.server";
import { processNegotiationAction } from "../models/negotiation-offer.server";

type ProductPriceResponse = {
  data: {
    product: {
      id: string;
      title: string;
      priceRangeV2: {
        minVariantPrice: { amount: string; currencyCode: string };
      };
      variants: { nodes: { id: string }[] };
    } | null;
  };
};

type VariantDetailsResponse = {
  data: {
    productVariant: {
      id: string;
      price: string;
      availableForSale: boolean;
      product: {
        id: string;
        priceRangeV2: {
          minVariantPrice: { currencyCode: string };
        };
      };
    } | null;
  };
};

// Looks up the specific variant the widget says is selected, and confirms
// it actually belongs to this product before trusting anything about it -
// a client-supplied id is never trusted blindly, otherwise a tampered
// request could negotiate a completely different, unrelated variant's
// price. Returns null for anything that doesn't check out (wrong product,
// out of stock, or the id doesn't resolve at all) - the caller falls back
// to the old first-variant behavior in that case, same as if no variantId
// had been sent at all.
type ResolvedVariant =
  | {
      ok: true;
      variantId: string;
      price: number;
      currencyCode: string;
    }
  // "invalid" (doesn't resolve, or belongs to a different product) falls
  // back to the old first-variant behavior, same as if no variantId had
  // been sent at all - could just be a stale id from a cached widget
  // script. "out_of_stock" is different: the shopper explicitly picked
  // this one, so silently negotiating a different variant instead would be
  // actively misleading - the caller rejects the request outright for that
  // case rather than falling back.
  | { ok: false; reason: "invalid" | "out_of_stock" };

async function resolveRequestedVariant(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  variantId: string,
  productId: string,
): Promise<ResolvedVariant> {
  const response = await admin.graphql(
    `#graphql
    query NegotiationVariantDetails($id: ID!) {
      productVariant(id: $id) {
        id
        price
        availableForSale
        product {
          id
          priceRangeV2 {
            minVariantPrice {
              currencyCode
            }
          }
        }
      }
    }`,
    { variables: { id: variantId } },
  );
  const json = (await response.json()) as VariantDetailsResponse;
  const variant = json.data.productVariant;
  if (!variant || variant.product.id !== productId) {
    return { ok: false, reason: "invalid" };
  }
  if (!variant.availableForSale) {
    return { ok: false, reason: "out_of_stock" };
  }
  return {
    ok: true,
    variantId: variant.id,
    price: Number(variant.price),
    currencyCode: variant.product.priceRangeV2.minVariantPrice.currencyCode,
  };
}

// Storefront-facing: POST https://{shop}/apps/negotiate/start
// Body: productId (required), triggerType (optional), variantId (optional -
// whichever variant the widget read as currently selected on the page; see
// readSelectedVariantId in widget.tsx). When present and it checks out
// (belongs to this product, in stock), that variant's own price is used.
// Otherwise falls back to the product's first variant, same as before this
// existed - covers older cached widget scripts that don't send one yet, and
// themes readSelectedVariantId couldn't read a variant from.
// firstAction (optional, "counter") + offerPrice (optional): the shopper's
// first message, sent together with the create request so the negotiation is
// only ever created once they actually say something (opening the panel
// creates nothing). Without firstAction this behaves exactly as before.
// Signature-verified by authenticate.public.appProxy - a client can't spoof
// which shop this request is for.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (!admin || !session) {
    // Store hasn't installed the app (or the request otherwise carries no
    // session) - nothing to negotiate against.
    return Response.json({ error: "not_installed" }, { status: 404 });
  }

  const shop = await getShopByDomain(session.shop);

  // ":start" suffix keeps this counter separate from /offer's - without it
  // both endpoints would share one bucket per IP+window and the two
  // different max thresholds would collide with each other.
  const rateLimitOk = await checkRateLimit(
    shop.id,
    getRateLimitKey(request) + ":start",
    { max: 200, windowMs: 10 * 60 * 1000 },
  );
  if (!rateLimitOk) {
    // No specific rule to pull custom copy from yet at this point (we don't
    // even know the productId until formData is read below) - falls back to
    // the generic default message, same as getRateLimitedMessage always
    // does when given nothing.
    return Response.json(
      { error: "rate_limited", message: getRateLimitedMessage(null) },
      { status: 429 },
    );
  }

  const formData = await request.formData();
  const productId = String(formData.get("productId") ?? "");
  // logged_in_customer_id is appended by Shopify itself to every proxied
  // request (not client-supplied, so it can be trusted); anonymousId is a
  // client-generated localStorage value the widget sends explicitly, since
  // app proxy strips the Cookie header - a normal session cookie never
  // reaches this endpoint.
  const loggedInCustomerId = new URL(request.url).searchParams.get(
    "logged_in_customer_id",
  );
  const customerId = loggedInCustomerId
    ? `gid://shopify/Customer/${loggedInCustomerId}`
    : null;
  const anonymousId = customerId
    ? null
    : String(formData.get("anonymousId") ?? "") || null;
  const triggerTypeRaw = String(formData.get("triggerType") ?? "ALWAYS_ON");
  const triggerType = (
    ["ALWAYS_ON", "DWELL_TIME", "EXIT_INTENT", "PAGE_REVISIT", "COHORT_EMAIL"] as const
  ).includes(triggerTypeRaw as never)
    ? (triggerTypeRaw as
        | "ALWAYS_ON"
        | "DWELL_TIME"
        | "EXIT_INTENT"
        | "PAGE_REVISIT"
        | "COHORT_EMAIL")
    : "ALWAYS_ON";

  if (!productId) {
    return Response.json({ error: "missing_product_id" }, { status: 400 });
  }

  const limits = await resolveEffectiveLimits(admin, shop.id, productId);
  if (!limits) {
    // Not enabled, or nothing configured to negotiate against. Deliberately
    // vague to a storefront caller - not confirming/denying internal
    // merchant configuration state to an anonymous visitor.
    return Response.json({ error: "not_negotiable" }, { status: 404 });
  }

  const variantIdRaw = String(formData.get("variantId") ?? "") || null;
  const firstAction = String(formData.get("firstAction") ?? "");

  let resolvedVariantId: string | undefined;
  let startingPrice: number | undefined;
  let currencyCode: string | undefined;

  if (variantIdRaw) {
    const requested = await resolveRequestedVariant(admin, variantIdRaw, productId);
    if (!requested.ok && requested.reason === "out_of_stock") {
      // The shopper explicitly picked this one - silently negotiating a
      // different variant instead would be actively misleading, so this
      // rejects outright rather than falling back.
      return Response.json(
        {
          error: "out_of_stock",
          message: "Sorry, this option is currently out of stock.",
        },
        { status: 404 },
      );
    }
    if (requested.ok) {
      resolvedVariantId = requested.variantId;
      startingPrice = requested.price;
      currencyCode = requested.currencyCode;
    }
    // reason === "invalid" (stale id, or belongs to a different product)
    // falls through to the same fallback lookup as no variantId at all.
  }

  if (resolvedVariantId === undefined) {
    // Fetches price AND the default variant in one round-trip, and both get
    // cached on the session below - specifically so the accept path (which
    // makes an unavoidable draftOrderCreate call already) never needs to
    // re-fetch this data. Each extra round-trip there is latency stacked on
    // a request already being proxied through the dev tunnel, and one such
    // redundant call was the actual cause of accept failing under load -
    // see the schema comment on NegotiationSession.currencyCode.
    const priceResponse = await admin.graphql(
      `#graphql
      query ProductPriceAndVariant($id: ID!) {
        product(id: $id) {
          id
          title
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          variants(first: 1) {
            nodes {
              id
            }
          }
        }
      }`,
      { variables: { id: productId } },
    );
    const priceJson = (await priceResponse.json()) as ProductPriceResponse;
    const product = priceJson.data.product;
    if (!product) {
      return Response.json({ error: "product_not_found" }, { status: 404 });
    }

    resolvedVariantId = product.variants.nodes[0]?.id;
    if (!resolvedVariantId) {
      return Response.json({ error: "no_variant" }, { status: 404 });
    }

    startingPrice = Number(product.priceRangeV2.minVariantPrice.amount);
    currencyCode = product.priceRangeV2.minVariantPrice.currencyCode;
  }

  // Unreachable in practice (both branches above always set all three
  // together) - only here so TypeScript can see that, since it can't
  // otherwise prove it across two separate conditionally-run blocks.
  if (startingPrice === undefined || currencyCode === undefined) {
    return Response.json({ error: "no_variant" }, { status: 404 });
  }

  const negotiationSession = await prisma.negotiationSession.create({
    data: {
      shopId: shop.id,
      productId,
      variantId: resolvedVariantId,
      currencyCode,
      customerId,
      anonymousId,
      status: "ACTIVE",
      triggerType,
      currentRound: 0,
      startingPrice,
      // Frozen at session start - see the schema comment on
      // NegotiationSession.ruleId for why (an edit to this rule later
      // shouldn't retroactively change this negotiation). segment is set
      // later, on the first real offer in proxy.offer.tsx - not known yet.
      ruleId: limits.rule.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  // The shopper's first message, handled in this same request instead of a
  // second /offer round trip right after (each proxied request adds real
  // latency). Same code path /offer uses for every later message. The result
  // is embedded as `offer` - and even if it's an error (e.g. the draft order
  // couldn't be created), the session itself already exists and is returned,
  // so the widget can carry on from here.
  if (firstAction === "counter") {
    const offerResponse = await processNegotiationAction({
      admin,
      negotiationSession,
      limits,
      action: "counter",
      offerPriceRaw: formData.get("offerPrice"),
    });
    return Response.json({
      sessionId: negotiationSession.id,
      startingPrice,
      currencyCode,
      offer: await offerResponse.json(),
    });
  }

  return Response.json({
    sessionId: negotiationSession.id,
    // Two separate messages, sent as two consecutive bot chat bubbles by
    // the widget - not one message with a line break. See
    // getGreetingMessage's doc comment. Only used by older cached widget
    // scripts, which still create the session the moment the panel opens -
    // the current widget shows the greeting from /eligibility instead.
    messages: getGreetingMessage(),
    startingPrice,
    currencyCode,
  });
};
