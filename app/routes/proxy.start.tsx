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

// Storefront-facing: POST https://{shop}/apps/negotiate/start
// Body: productId (required), triggerType (optional). No client-supplied
// variantId - the session resolves and locks in the product's default
// variant itself (v1 limitation, see the comment near resolvedVariantId).
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

  // Fetches price AND the default variant in one round-trip, and both get
  // cached on the session below - specifically so the accept path (which
  // makes an unavoidable draftOrderCreate call already) never needs to
  // re-fetch this data. Each extra round-trip there is latency stacked on
  // a request already being proxied through the dev tunnel, and one such
  // redundant call was the actual cause of accept failing under load - see
  // the schema comment on NegotiationSession.currencyCode.
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

  const resolvedVariantId = product.variants.nodes[0]?.id;
  if (!resolvedVariantId) {
    return Response.json({ error: "no_variant" }, { status: 404 });
  }

  const startingPrice = Number(product.priceRangeV2.minVariantPrice.amount);
  const currencyCode = product.priceRangeV2.minVariantPrice.currencyCode;

  const negotiationSession = await prisma.negotiationSession.create({
    data: {
      shopId: shop.id,
      productId,
      // v1 limitation (stated elsewhere too): defaults to the product's
      // first variant rather than whatever the visitor actually wants -
      // the client-supplied variantId param isn't used for this yet.
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

  return Response.json({
    sessionId: negotiationSession.id,
    // Two separate messages, sent as two consecutive bot chat bubbles by
    // the widget - not one message with a line break. See
    // getGreetingMessage's doc comment.
    messages: getGreetingMessage(),
    startingPrice,
    currencyCode,
  });
};
